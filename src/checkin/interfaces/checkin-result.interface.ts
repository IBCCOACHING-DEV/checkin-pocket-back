export interface CheckinResult {
  success: boolean;
  alreadyCheckedIn?: boolean;
  message: string;
  studentId?: number;
  studentName?: string;
  courseName?: string;
  /** true se este check-in mandou a etiqueta para impressão; false se já havia sido impressa antes (só a presença foi registrada). */
  labelPrinted?: boolean;
  printJobId?: number;
}
