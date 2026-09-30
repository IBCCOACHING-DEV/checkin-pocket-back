export interface TransferSearchResult {
  studentId: number;
  courseId: number;
  courseName: string;
  currentOwnerName: string | null;
  currentOwnerEmail: string | null;
  currentOwnerDocument: string | null;
}
