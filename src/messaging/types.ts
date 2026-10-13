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
  /**
   * true se este check-in enviou a etiqueta para impressão; false se ela já
   * havia sido impressa (presença de um dia seguinte). Ausente em mensagens de
   * estações antigas — nesse caso, tratar como true.
   */
  labelPrinted?: boolean;
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
    labelPrinted: typeof candidate.labelPrinted === 'boolean' ? candidate.labelPrinted : undefined,
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

/**
 * Payload publicado no exchange `ibc.checkin.events` (routing key
 * `student.create.requested`) quando um operador cadastra um aluno
 * manualmente nesta estação. Consumido exclusivamente pelo Checkin Pai, que
 * cria o Student como no formulário de cortesia (`StudentsController#create`),
 * preenchendo `consultant_name`, `financial_status` e `course_status` com
 * "Cadastro Manual", e SEM criar cliente no Coliseum (`ibc_customer_id` fica
 * nulo, igual ao cadastro de cortesia do Pai).
 *
 * `token` é gerado pelo Pocket e DEVE ser reaproveitado pelo Pai (ele só
 * gera token quando vem em branco): o QR impresso na estação continua válido
 * depois da confirmação. Também é a chave de correlação — o `studentId` de
 * check-ins feitos antes da confirmação é provisório (negativo) e o Pai deve
 * localizar o aluno pelo `studentToken`.
 */
export interface StudentCreateRequestedMessage {
  /** id do StudentRegistration local — chave de idempotência para o Pai. */
  eventId: string;
  courseId: number;
  token: string;
  name: string;
  nickName: string;
  document: string;
  email: string;
  phone?: string;
  ownerName?: string;
  ownerDocument?: string;
  /** Obrigatória no cadastro manual: motivo/contexto do cadastro. */
  note: string;
  sourceAgentKey: string;
  occurredAt: string;
}

/**
 * Payload publicado pelo Checkin Pai (routing key `student.create.completed`)
 * com o resultado do cadastro. Consumido por TODAS as estações (fan-out).
 */
export interface StudentCreateCompletedMessage {
  eventId: string;
  success: boolean;
  errorMessage?: string;
  student?: {
    /** ID definitivo do Student no Checkin Pai. */
    id: number;
    courseId: number;
    courseName: string | null;
    name: string;
    token: string;
    email: string | null;
    document: string | null;
    ibcCustomerId: number | null;
    /** Tipo da turma no Pai ("event"/"formation"), quando informado. */
    courseEventType?: string | null;
  };
  occurredAt: string;
}

/**
 * Valida e converte uma mensagem `student.create.completed` recebida do
 * RabbitMQ. Lança erro em caso de payload malformado, fazendo o consumer
 * descartar a mensagem para a dead-letter queue em vez de travar.
 */
export function parseStudentCreateCompletedMessage(raw: unknown): StudentCreateCompletedMessage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Mensagem de cadastro de aluno inválida: payload não é um objeto.');
  }

  const candidate = raw as Record<string, unknown>;

  if (!isNonEmptyString(candidate.eventId)) {
    throw new Error('Mensagem de cadastro de aluno inválida: campo "eventId" ausente ou vazio.');
  }

  if (typeof candidate.success !== 'boolean') {
    throw new Error('Mensagem de cadastro de aluno inválida: "success" ausente ou não booleano.');
  }

  if (!isNonEmptyString(candidate.occurredAt)) {
    throw new Error('Mensagem de cadastro de aluno inválida: campo "occurredAt" ausente ou vazio.');
  }

  let student: StudentCreateCompletedMessage['student'];
  if (candidate.success) {
    if (typeof candidate.student !== 'object' || candidate.student === null) {
      throw new Error('Mensagem de cadastro de aluno inválida: "student" ausente em um cadastro bem-sucedido.');
    }
    const s = candidate.student as Record<string, unknown>;
    if (!isFiniteNumber(s.id) || !isFiniteNumber(s.courseId)) {
      throw new Error('Mensagem de cadastro de aluno inválida: "student.id"/"student.courseId" ausentes ou não numéricos.');
    }
    if (!isNonEmptyString(s.name) || !isNonEmptyString(s.token)) {
      throw new Error('Mensagem de cadastro de aluno inválida: "student.name"/"student.token" ausentes.');
    }
    student = {
      id: s.id,
      courseId: s.courseId,
      courseName: typeof s.courseName === 'string' ? s.courseName : null,
      name: s.name,
      token: s.token,
      email: typeof s.email === 'string' ? s.email : null,
      document: typeof s.document === 'string' ? s.document : null,
      ibcCustomerId: isFiniteNumber(s.ibcCustomerId) ? s.ibcCustomerId : null,
      courseEventType: typeof s.courseEventType === 'string' ? s.courseEventType : null,
    };
  }

  return {
    eventId: candidate.eventId,
    success: candidate.success,
    errorMessage: isNonEmptyString(candidate.errorMessage) ? candidate.errorMessage : undefined,
    student,
    occurredAt: candidate.occurredAt,
  };
}
