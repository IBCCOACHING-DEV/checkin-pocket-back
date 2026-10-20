import { Injectable, Logger } from '@nestjs/common';
import {
  IPrinterService,
  LabelExtras,
  PrinterInfo,
  PrintResult,
} from './base-printer.interface';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as temp from 'temp';
import * as fs from 'fs-extra';
import * as path from 'path';
import { renderLabelPng } from '../label-image';
import { renderLabelRasterCommands } from '../label-raster';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// SumatraPDF (portátil, sem instalador) bundlado no projeto — imprime um PDF
// já no tamanho físico exato via `-print-settings noscale`, sem o overhead
// de `System.Drawing.Printing`/PowerShell (que ficava preso ~2.3-2.9s por
// etiqueta) nem os problemas de escala do `mspaint /pt` (que ignora o DPI do
// PNG). Chamado direto via execFile, sem shell/PowerShell no meio — decisivo
// nos notebooks fracos (4GB RAM) usados nos eventos.
const SUMATRA_PDF_PATH = path.join(__dirname, '../../../assets/bin/SumatraPDF-64.exe');

// Helper nativo (C#, compilado com o csc.exe do .NET Framework — ver
// assets/bin-src/RawPrinterHelper.cs) que envia bytes já no protocolo
// raster nativo da Brother direto pra fila de impressão do Windows como
// datatype RAW (OpenPrinter/StartDocPrinter/WritePrinter/EndDocPrinter via
// winspool.drv). Isso pula a renderização GDI/EMF que o driver da Brother
// faz — identificada como a origem do ~1.2-1.3s "invisível" entre o log de
// impressão terminar e o barulho da impressora começar (ver CLAUDE.md §5 e
// o plano de investigação desta sessão). A impressora continua registrada
// normalmente no Windows — getPrinters()/getDefaultPrinter() e o caminho
// via SumatraPDF acima continuam funcionando exatamente como antes.
const RAW_PRINTER_HELPER_PATH = path.join(__dirname, '../../../assets/bin/RawPrinterHelper.exe');

const PRINT_TIMEOUT_MS = 10000;

@Injectable()
export class WindowsPrinterService implements IPrinterService {
  private readonly logger = new Logger(WindowsPrinterService.name);

  async getPrinters(): Promise<PrinterInfo[]> {
    const { stdout } = await execAsync(
      'powershell -Command "Get-Printer | Select-Object Name, Default, PrinterStatus, PortName | ConvertTo-Json -Compress"',
    );

    const raw: any[] = JSON.parse(stdout.trim());
    const list = Array.isArray(raw) ? raw : [raw];

    return list.map((p) => ({
      name: p.Name,
      isDefault: p.Default === true,
      status: String(p.PrinterStatus ?? 'unknown'),
      isOnline: this.isPrinterOnline(
        String(p.PrinterStatus ?? ''),
        String(p.PortName ?? ''),
      ),
      description: `${p.Name} (${String(p.PortName ?? 'unknown-port')})`,
    }));
  }

  async printPDF(
    pdfBuffer: Buffer,
    printerName: string,
    copies: number = 1,
  ): Promise<PrintResult> {
    const tempFile = temp.openSync({ suffix: '.pdf' });
    await fs.writeFile(tempFile.path, pdfBuffer);

    try {
      const escapedFilePath = this.escapePowerShellSingleQuoted(tempFile.path);
      const escapedPrinterName = this.escapePowerShellSingleQuoted(printerName);

      for (let i = 0; i < copies; i++) {
        const script =
          `$ErrorActionPreference='Stop'; ` +
          `Start-Process -FilePath '${escapedFilePath}' -Verb PrintTo -ArgumentList '${escapedPrinterName}' -Wait -WindowStyle Hidden;`;
        await this.execPowerShell(script);
      }

      const jobId = `win-${Date.now()}`;

      this.logger.log(
        `PDF enviado para impressão Windows - Job: ${jobId}, Impressora: ${printerName}`,
      );

      setTimeout(() => fs.unlinkSync(tempFile.path), 30000);

      return {
        success: true,
        jobId,
        printer: printerName,
        timestamp: new Date(),
      };
    } catch (error) {
      fs.unlinkSync(tempFile.path);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Falha ao imprimir PDF: ${errorMessage}`);
    }
  }

  async printText(
    name: string,
    nickname: string,
    printerName: string,
    copies: number = 1,
    course?: string,
    extras: LabelExtras = {},
  ): Promise<PrintResult> {
    const tempPngPath = path.join(process.cwd(), `print_${Date.now()}.png`);
    const overallStart = Date.now();

    try {
      const canvasStart = Date.now();
      const pngBuffer = renderLabelPng({ name, nickname, course, ...extras });
      const canvasMs = Date.now() - canvasStart;

      const writeStart = Date.now();
      await fs.writeFile(tempPngPath, pngBuffer);
      const writeMs = Date.now() - writeStart;

      // O PNG não carrega DPI (canvas nativo não grava chunk pHYs), então
      // `-print-settings noscale` faria o Sumatra assumir 96dpi e imprimir
      // gigante/cortado (mesma classe de bug do `mspaint /pt`, ver histórico
      // em CLAUDE.md). `fit` escala a imagem pro papel configurado no driver
      // (etiqueta 90x29mm) e já respeita a área imprimível — testado
      // fisicamente sem cortar texto, ~400ms mais rápido que embrulhar em
      // PDF via pdfkit primeiro.
      for (let i = 0; i < copies; i++) {
        const copyStart = Date.now();
        await execFileAsync(
          SUMATRA_PDF_PATH,
          ['-print-to', printerName, '-print-settings', 'fit', '-silent', tempPngPath],
          { timeout: PRINT_TIMEOUT_MS, windowsHide: true },
        );
        this.logger.debug(
          `Cópia ${i + 1}/${copies} — SumatraPDF levou ${Date.now() - copyStart}ms.`,
        );
      }

      const jobId = `win-${Date.now()}`;

      if (fs.existsSync(tempPngPath)) {
        fs.unlinkSync(tempPngPath);
      }

      this.logger.log(
        `printText total: ${Date.now() - overallStart}ms (canvas=${canvasMs}ms, write=${writeMs}ms, impressora=${printerName}).`,
      );

      return {
        success: true,
        jobId,
        printer: printerName,
        timestamp: new Date(),
      };
    } catch (error) {
      if (fs.existsSync(tempPngPath)) fs.unlinkSync(tempPngPath);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Falha ao imprimir: ${errorMessage}`);
    }
  }

  /**
   * Caminho experimental (opt-in via PRINT_USE_RAW_RASTER) que gera o
   * protocolo raster nativo da Brother QL-810W e envia como datatype RAW
   * via RawPrinterHelper.exe, pulando a renderização GDI/EMF que o driver
   * faz hoje no caminho `printText` acima. Validado fisicamente nesta
   * estação — ver label-raster.ts pros detalhes do protocolo. Copia o
   * mesmo contrato de erro do printText (nunca lança, sempre PDF/PrintResult
   * — quem chama já espera isso, ver base-printer.interface.ts).
   */
  async printTextRaw(
    name: string,
    nickname: string,
    printerName: string,
    copies: number = 1,
    course?: string,
    extras: LabelExtras = {},
  ): Promise<PrintResult> {
    const tempJobPath = path.join(process.cwd(), `print_raw_${Date.now()}.bin`);
    const overallStart = Date.now();

    try {
      const canvasStart = Date.now();
      const jobBytes = renderLabelRasterCommands({ name, nickname, course, ...extras });
      const canvasMs = Date.now() - canvasStart;

      await fs.writeFile(tempJobPath, jobBytes);

      for (let i = 0; i < copies; i++) {
        const copyStart = Date.now();
        await execFileAsync(
          RAW_PRINTER_HELPER_PATH,
          [printerName, tempJobPath],
          { timeout: PRINT_TIMEOUT_MS, windowsHide: true },
        );
        this.logger.debug(
          `Cópia ${i + 1}/${copies} — RawPrinterHelper levou ${Date.now() - copyStart}ms.`,
        );
      }

      const jobId = `win-raw-${Date.now()}`;

      if (fs.existsSync(tempJobPath)) {
        fs.unlinkSync(tempJobPath);
      }

      this.logger.log(
        `printTextRaw total: ${Date.now() - overallStart}ms (raster=${canvasMs}ms, impressora=${printerName}).`,
      );

      return {
        success: true,
        jobId,
        printer: printerName,
        timestamp: new Date(),
      };
    } catch (error) {
      if (fs.existsSync(tempJobPath)) fs.unlinkSync(tempJobPath);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Falha ao imprimir (raw raster): ${errorMessage}`);
    }
  }

  async getDefaultPrinter(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        'powershell -Command "(Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE Default=True\\").Name"',
      );

      const name = stdout.trim();
      if (!name) {
        throw new Error('Nenhuma impressora padrão configurada no Windows');
      }
      return name;
    } catch (error) {
      this.logger.warn('Não foi possível obter impressora padrão:', error);
      return 'PDF';
    }
  }

  private isPrinterOnline(status: string, portName: string): boolean {
    const normalizedStatus = String(status || '').toLowerCase();
    const normalizedPort = String(portName || '').toLowerCase();

    if (this.isLocalPort(normalizedPort)) {
      return true;
    }

    if (!normalizedStatus) {
      return true;
    }

    if (
      normalizedStatus.includes('offline') ||
      normalizedStatus.includes('error') ||
      normalizedStatus.includes('not available') ||
      normalizedStatus === '7' ||
      normalizedStatus === '128'
    ) {
      return false;
    }

    return true;
  }

  private isLocalPort(portName: string): boolean {
    return (
      portName.startsWith('usb') ||
      portName.startsWith('dot4') ||
      portName.startsWith('lpt') ||
      portName.startsWith('com') ||
      portName.startsWith('wsd')
    );
  }

  /**
   * Invoca o powershell.exe diretamente via execFile (sem passar por
   * cmd.exe, ao contrário de `exec`) — evita um processo extra por chamada
   * e a necessidade de escapar o script para sobreviver ao parsing do
   * cmd.exe além do do próprio PowerShell.
   */
  private async execPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
  }

  private escapePowerShellSingleQuoted(value: string): string {
    return String(value || '').replace(/'/g, "''");
  }
}
