export interface RegistrationStatus {
  id: string;
  /** pending: aguardando o Checkin Pai criar o aluno via RabbitMQ. completed/failed: resultado final. */
  status: string;
  courseId: number;
  studentName: string;
  /** Token do voucher (QR) — já válido para check-in nesta estação, antes mesmo da confirmação do Pai. */
  token: string;
  /** ID provisório (negativo) enquanto pendente; passa a ser o definitivo do Pai depois de confirmado. */
  studentId: number;
  errorMessage: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}
