export interface TransferSearchResult {
  studentId: number;
  courseId: number;
  courseName: string;
  currentOwnerName: string | null;
  currentOwnerEmail: string | null;
  currentOwnerDocument: string | null;
  /**
   * O titular atual já foi credenciado (presença no Checkin Pai OU registrada
   * nesta estação/em outra e ainda não confirmada pelo Pai). A etiqueta pode
   * já ter sido entregue a ele.
   */
  checkedIn: boolean;
  /** Presença mais recente conhecida (a mais nova entre o Pai e esta estação). */
  checkedInAt: Date | null;
}
