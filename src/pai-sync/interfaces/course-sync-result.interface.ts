/** Resumo do download das turmas ativas disparado pelo "Sincronizar agora" do login. */
export interface ActiveCoursesSyncSummary {
  /** Quantas turmas ativas existem no Checkin Pai. */
  total: number;
  /** Quantas foram baixadas/atualizadas com sucesso. */
  synced: number;
  /** Quantas falharam (as demais seguem normalmente — falha isolada por turma). */
  failed: number;
  /** Quantas turmas que não estão mais ativas no Pai foram ocultadas nesta estação (dados mantidos). */
  hiddenCourses: number;
  /** Quantos alunos dessas turmas passaram a ficar ocultos. */
  hiddenStudents: number;
  /** Preenchido quando nem foi possível consultar o Pai (rede indisponível). */
  error: string | null;
}

export interface CourseSyncResult {
  courseId: number;
  courseName: string;
  /** Total de Students encontrados para esta turma no Checkin Pai. */
  totalStudents: number;
  /** Quantos foram gravados/atualizados na réplica local. */
  synced: number;
  /** Quantos alunos que não existem mais nesta turma no Checkin Pai foram removidos da réplica local. */
  removed: number;
  /** Quantos foram ignorados (sem nome ou sem token — não localizáveis via QR Code). */
  skipped: number;
}
