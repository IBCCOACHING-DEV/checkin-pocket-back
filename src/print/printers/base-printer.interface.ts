import { SrvRecord } from 'dns';

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  status: string;
  isOnline: boolean;
  description?: string;
}

export interface PrintResult {
  success: boolean;
  jobId?: string;
  error?: string;
  printer: string;
  timestamp: Date;
}

/** Campos opcionais da etiqueta além de nome/apelido/turma. */
export interface LabelExtras {
  token?: string;
  city?: string;
}

export interface IPrinterService {
  getPrinters(): Promise<PrinterInfo[]>;
  printPDF(
    pdfBuffer: Buffer,
    printerName: string,
    copies?: number,
  ): Promise<PrintResult>;
  printText(
    name: string,
    nickname: string,
    printerName: string,
    copies?: number,
    course?: string,
    extras?: LabelExtras,
  ): Promise<PrintResult>;
  /**
   * Caminho experimental opt-in (Windows apenas — ver PRINT_USE_RAW_RASTER
   * em configuration.ts) que bypassa GDI/driver enviando o protocolo
   * raster nativo da impressora direto via datatype RAW. Opcional na
   * interface porque só a WindowsPrinterService implementa; LinuxPrinterService
   * não precisa (CUPS já lida bem com o caminho normal, ver CLAUDE.md §5).
   */
  printTextRaw?(
    name: string,
    nickname: string,
    printerName: string,
    copies?: number,
    course?: string,
    extras?: LabelExtras,
  ): Promise<PrintResult>;
  getDefaultPrinter(): Promise<string>;
}
