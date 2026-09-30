export interface TransferStatus {
  id: string;
  status: string; // pending | completed | failed
  studentId: number;
  courseId: number;
  errorMessage: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /**
   * true se o aluno já existia na réplica local desta estação e foi
   * atualizado (nome/e-mail/documento) na hora, na mesma transação que
   * criou a solicitação — sem esperar a confirmação do Checkin Pai. Só
   * vem preenchido na resposta imediata de POST /ticket-transfer/request;
   * `undefined` numa consulta de status posterior (GET /ticket-transfer/:id).
   */
  appliedLocally?: boolean;
}
