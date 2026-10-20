import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IPrinterService,
  PrinterInfo,
  PrintResult,
} from './printers/base-printer.interface';
import { WindowsPrinterService } from './printers/windows-printer.service';
import { LinuxPrinterService } from './printers/linux-printer.service';
import { PrintPdfDto } from './dto/print-pdf.dto';
import { PrintTextDto } from './dto/print-text.dto';

@Injectable()
export class PrintService {
  private readonly logger = new Logger(PrintService.name);
  private readonly printerService: IPrinterService;

  constructor(private readonly configService: ConfigService) {
    this.printerService =
      process.platform === 'win32'
        ? new WindowsPrinterService()
        : new LinuxPrinterService();

    this.logger.log(
      `✅ Serviço de impressão inicializado para: ${process.platform}`,
    );
  }

  async getPrinters(): Promise<PrinterInfo[]> {
    try {
      const printers = await this.printerService.getPrinters();
      this.logger.log(`📋 ${printers.length} impressoras encontradas`);
      return printers;
    } catch (error) {
      this.logger.error('Erro ao listar impressoras:', error);
      throw error;
    }
  }

  async printPDF(printDto: PrintPdfDto): Promise<PrintResult> {
    const printerName =
      printDto.printerName || (await this.printerService.getDefaultPrinter());

    this.logger.log(
      `📄 Iniciando impressão PDF - Plataforma: ${process.platform}, Impressora: ${printerName}`,
    );

    try {
      const pdfBuffer = Buffer.from(printDto.pdfData, 'base64');
      const result = await this.printerService.printPDF(
        pdfBuffer,
        printerName,
        printDto.copies,
      );

      this.logger.log(`✅ PDF impresso com sucesso - Job: ${result.jobId}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Erro na impressão PDF: ${message}`);
      return {
        success: false,
        error: message,
        printer: printerName,
        timestamp: new Date(),
      };
    }
  }

  async printText(printDto: PrintTextDto): Promise<PrintResult> {
    if (!printDto.printerName) {
      // getDefaultPrinter() no Windows consulta o WMI via PowerShell — ~2s
      // por chamada numa máquina fraca. Isso deveria ser raro: em condições
      // normais, print_job.targetPrinterUid já vem preenchido a partir de
      // DEFAULT_PRINTER (ver CheckinService#defaultPrinterUid). Se isso
      // aparecer nos logs de um evento, é sinal de que DEFAULT_PRINTER não
      // foi configurado nesta estação — cada etiqueta está pagando ~2s à
      // toa até isso ser corrigido.
      this.logger.warn(
        'printText chamado sem printerName — caindo no fallback lento (WMI/PowerShell). Verifique se DEFAULT_PRINTER está configurado no .env desta estação.',
      );
    }

    const printerName =
      printDto.printerName || (await this.printerService.getDefaultPrinter());

    this.logger.log(
      `📝 Iniciando impressão texto - Plataforma: ${process.platform}, Impressora: ${printerName}`,
    );

    const useRawRaster =
      process.platform === 'win32' &&
      !printDto.forceSumatra &&
      this.configService.get<boolean>('print.useRawRaster', false) &&
      typeof this.printerService.printTextRaw === 'function';

    if (printDto.forceSumatra) {
      this.logger.warn(
        '⚠️ Retry forçando o caminho Sumatra (a 1ª tentativa via raw falhou para este print_job) — ver tentativa anterior nos logs.',
      );
    }

    try {
      const result = useRawRaster
        ? await this.printerService.printTextRaw(
            printDto.name,
            printDto.nickname,
            printerName,
            printDto.copies,
            printDto.course,
            { token: printDto.token, city: printDto.city },
          )
        : await this.printerService.printText(
            printDto.name,
            printDto.nickname,
            printerName,
            printDto.copies,
            printDto.course,
            { token: printDto.token, city: printDto.city },
          );

      this.logger.log(`✅ Texto impresso com sucesso - Job: ${result.jobId}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Erro na impressão texto: ${message}`);
      return {
        success: false,
        error: message,
        printer: printerName,
        timestamp: new Date(),
      };
    }
  }

  async validatePrinter(printerName: string): Promise<boolean> {
    const printers = await this.getPrinters();
    return printers.some((printer) => printer.name === printerName);
  }

  async getPrinterInfo(printerName: string): Promise<PrinterInfo | null> {
    const printers = await this.getPrinters();
    return printers.find((printer) => printer.name === printerName) || null;
  }

  async getSystemInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      printerService: this.printerService.constructor.name,
      nodeVersion: process.version,
    };
  }
}
