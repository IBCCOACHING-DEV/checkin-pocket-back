/**
 * Payload publicado no exchange `ibc.checkin.events` quando um check-in é
 * realizado em QUALQUER instância do Checkin Pocket. É consumido por todas
 * as outras instâncias (para sincronizar o SQLite local) e, futuramente,
 * pelo Checkin Pai (Rails) para atualizar o Student remoto.
 */
export interface CheckinPerformedMessage {
  eventId: string;
  studentId: number;
  courseId: number;
  studentName: string;
  courseName: string;
  studentToken: string;
  /** ISO-8601 — instante em que o check-in ocorreu na estação de origem. */
  checkedInAt: string;
  /** agentKey da estação (computador) que realizou o check-in. */
  sourceAgentKey: string;
  /** ISO-8601 — instante em que o evento foi gerado (para auditoria). */
  occurredAt: string;
}

/**
 * Payload publicado no exchange de dead-letter de impressão quando um
 * print_job esgota o número máximo de tentativas.
 */
export interface PrintJobDeadLetterMessage {
  printJobId: number;
  studentId: number | null;
  targetPrinterUid: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  sourceAgentKey: string;
  occurredAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Valida e converte uma mensagem recebida do RabbitMQ (tipo `unknown`, pois
 * vem de `JSON.parse`) em um `CheckinPerformedMessage` fortemente tipado.
 * Lança erro em caso de payload malformado, o que faz o consumer descartar
 * a mensagem para a dead-letter queue em vez de travar o processamento.
 */
export function parseCheckinPerformedMessage(raw: unknown): CheckinPerformedMessage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Mensagem de check-in inválida: payload não é um objeto.');
  }

  const candidate = raw as Record<string, unknown>;

  const requiredStringFields: Array<keyof CheckinPerformedMessage> = [
    'eventId',
    'studentName',
    'courseName',
    'studentToken',
    'checkedInAt',
    'sourceAgentKey',
    'occurredAt',
  ];

  for (const field of requiredStringFields) {
    if (!isNonEmptyString(candidate[field])) {
      throw new Error(`Mensagem de check-in inválida: campo "${field}" ausente ou vazio.`);
    }
  }

  if (typeof candidate.studentId !== 'number' || !Number.isFinite(candidate.studentId)) {
    throw new Error('Mensagem de check-in inválida: "studentId" ausente ou não numérico.');
  }

  if (typeof candidate.courseId !== 'number' || !Number.isFinite(candidate.courseId)) {
    throw new Error('Mensagem de check-in inválida: "courseId" ausente ou não numérico.');
  }

  return {
    eventId: candidate.eventId as string,
    studentId: candidate.studentId,
    courseId: candidate.courseId,
    studentName: candidate.studentName as string,
    courseName: candidate.courseName as string,
    studentToken: candidate.studentToken as string,
    checkedInAt: candidate.checkedInAt as string,
    sourceAgentKey: candidate.sourceAgentKey as string,
    occurredAt: candidate.occurredAt as string,
  };
}

/**
 * Payload publicado no exchange `ibc.checkin.events` (routing key
 * `transfer.requested`) quando um operador solicita a transferência de um
 * ingresso nesta estação. Consumido exclusivamente pelo Checkin Pai — é
 * ele quem tem as credenciais para chamar o Coliseum (ver
 * Students::ColiseumTransferService no repo do Checkin Pai).
 */
export interface TransferRequestedMessage {
  eventId: string;
  studentId: number;
  courseId: number;
  name: string;
  email: string;
  phone: string;
  document?: string;
  nickName?: string;
  note?: string;
  sourceAgentKey: string;
  occurredAt: string;
}

/**
 * Payload publicado pelo Checkin Pai (routing key `transfer.completed`)
 * com o resultado de uma transferência de ingresso. Consumido por TODAS
 * as estações (fan-out): cada uma atualiza sua réplica local do Student
 * quando `success` é true — inclusive o `token`, que o Pai regenera
 * automaticamente quando a titularidade do ingresso muda (ver
 * Student#handle_ownership_change no Checkin Pai).
 */
export interface TransferCompletedMessage {
  eventId: string;
  studentId: number;
  success: boolean;
  errorMessage?: string;
  student?: {
    name: string;
    email: string | null;
    document: string | null;
    nickName: string | null;
    token: string;
    /**
     * Turma do aluno — necessária para criar um registro mínimo quando
     * esta estação nunca sincronizou esse aluno antes (a transferência
     * precisa aparecer aqui de qualquer forma, ver
     * StudentsService#applyRemoteTransfer).
     */
    courseId: number;
    courseName: string | null;
  };
  occurredAt: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Valida e converte uma mensagem `transfer.completed` recebida do
 * RabbitMQ em um `TransferCompletedMessage` fortemente tipado. Lança erro
 * em caso de payload malformado, fazendo o consumer descartar a mensagem
 * para a dead-letter queue em vez de travar o processamento.
 */
export function parseTransferCompletedMessage(raw: unknown): TransferCompletedMessage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Mensagem de transferência inválida: payload não é um objeto.');
  }

  const candidate = raw as Record<string, unknown>;

  if (!isNonEmptyString(candidate.eventId)) {
    throw new Error('Mensagem de transferência inválida: campo "eventId" ausente ou vazio.');
  }

  if (!isFiniteNumber(candidate.studentId)) {
    throw new Error('Mensagem de transferência inválida: "studentId" ausente ou não numérico.');
  }

  if (typeof candidate.success !== 'boolean') {
    throw new Error('Mensagem de transferência inválida: "success" ausente ou não booleano.');
  }

  if (!isNonEmptyString(candidate.occurredAt)) {
    throw new Error('Mensagem de transferência inválida: campo "occurredAt" ausente ou vazio.');
  }

  let student: TransferCompletedMessage['student'];
  if (candidate.student !== undefined && candidate.student !== null) {
    if (typeof candidate.student !== 'object') {
      throw new Error('Mensagem de transferência inválida: "student" não é um objeto.');
    }
    const studentCandidate = candidate.student as Record<string, unknown>;
    if (!isNonEmptyString(studentCandidate.name) || !isNonEmptyString(studentCandidate.token)) {
      throw new Error('Mensagem de transferência inválida: "student.name"/"student.token" ausentes.');
    }
    if (!isFiniteNumber(studentCandidate.courseId)) {
      throw new Error('Mensagem de transferência inválida: "student.courseId" ausente ou não numérico.');
    }
    student = {
      name: studentCandidate.name,
      email: typeof studentCandidate.email === 'string' ? studentCandidate.email : null,
      document: typeof studentCandidate.document === 'string' ? studentCandidate.document : null,
      nickName: typeof studentCandidate.nickName === 'string' ? studentCandidate.nickName : null,
      token: studentCandidate.token,
      courseId: studentCandidate.courseId,
      courseName: typeof studentCandidate.courseName === 'string' ? studentCandidate.courseName : null,
    };
  }

  return {
    eventId: candidate.eventId,
    studentId: candidate.studentId,
    success: candidate.success,
    errorMessage: isNonEmptyString(candidate.errorMessage) ? candidate.errorMessage : undefined,
    student,
    occurredAt: candidate.occurredAt,
  };
}
