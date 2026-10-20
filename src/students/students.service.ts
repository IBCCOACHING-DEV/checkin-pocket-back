import { Injectable, Logger } from '@nestjs/common';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { Student } from '../../generated/prisma-local';
import { StudentReplicaDto } from './dto/upsert-students.dto';
import { CourseScope, studentScopeWhere } from '../auth/course-scope';
import { localIsoDate } from '../checkin/local-date';

export interface RemoteCheckinPayload {
  id: number;
  name: string;
  courseId: number;
  courseName: string;
  token: string;
  checkedInAt: Date;
  /** O check-in remoto mandou a etiqueta para impressão (na estação de origem). */
  labelPrinted?: boolean;
}

export interface RemoteTransferPayload {
  name: string;
  email: string | null;
  document: string | null;
  /** Novo token do voucher — o Checkin Pai regenera o token quando a titularidade muda. */
  token: string;
  /** Necessário para criar um registro mínimo quando esta estação nunca sincronizou esse aluno antes. */
  courseId: number;
  courseName: string | null;
}

/** Aluno recém-criado no Checkin Pai (evento `student.create.completed`). */
export interface RemoteStudentCreatedPayload {
  /** ID definitivo do Student no Checkin Pai. */
  id: number;
  courseId: number;
  courseName: string | null;
  name: string;
  token: string;
  email: string | null;
  document: string | null;
  ibcCustomerId: number | null;
  /** Tipo da turma ("event"/"formation"), quando o Pai informa. */
  courseEventType?: string | null;
}

/** Dados de um aluno cadastrado manualmente nesta estação (ainda sem id do Pai). */
export interface ProvisionalStudentData {
  courseId: number;
  courseName: string;
  courseEventDate: string | null;
  courseEventDateEnd: string | null;
  courseEventType: string | null;
  name: string;
  token: string;
  email: string;
  document: string;
}

export interface LocalTransferPayload {
  name: string;
  email: string | null;
  document: string | null;
}

export interface SyncedCourseSummary {
  courseId: number;
  courseName: string;
  studentsCount: number;
  /** Sincronização mais recente entre os alunos desta turma nesta estação. */
  lastSyncedAt: Date;
}

export interface StudentSearchResult {
  id: number;
  name: string;
  email: string | null;
  document: string | null;
  courseId: number;
  courseName: string;
  checkedIn: boolean;
  checkedInAt: Date | null;
  /** Presença já registrada HOJE (eventos de vários dias têm uma presença por dia). */
  checkedInToday: boolean;
  /** A etiqueta já foi impressa — o próximo check-in registra só a presença. */
  labelPrinted: boolean;
  token: string;
  /** true se o aluno foi cadastrado nesta estação e o Checkin Pai ainda não confirmou (id provisório). */
  pendingConfirmation: boolean;
}

/**
 * Alunos cadastrados manualmente numa estação recebem um id PROVISÓRIO
 * negativo até o Checkin Pai confirmar (ids reais do Pai são sempre > 0).
 */
export function isProvisionalStudentId(id: number): boolean {
  return id < 0;
}

const SEARCH_RESULTS_LIMIT = 50;

@Injectable()
export class StudentsService {
  private readonly logger = new Logger(StudentsService.name);

  constructor(private readonly prisma: LocalPrismaService) {}

  findByToken(token: string): Promise<Student | null> {
    return this.prisma.student.findUnique({ where: { token } });
  }

  findById(id: number): Promise<Student | null> {
    return this.prisma.student.findUnique({ where: { id } });
  }

  /**
   * Busca alunos já sincronizados nesta estação por nome, e-mail ou
   * documento — alternativa ao QR Code para quando o operador não tem o
   * voucher em mãos. Retorna a turma e o status de check-in de cada
   * resultado, já que o mesmo nome pode aparecer em mais de uma turma ou
   * já ter sido credenciado por outra estação (sincronizado via RabbitMQ).
   */
  async search(query: string, scope?: CourseScope): Promise<StudentSearchResult[]> {
    const term = query.trim();
    if (term.length < 2) {
      return [];
    }

    const students = await this.prisma.student.findMany({
      where: {
        ...studentScopeWhere(scope),
        OR: [
          { name: { contains: term } },
          { email: { contains: term } },
          { document: { contains: term } },
        ],
      },
      orderBy: { name: 'asc' },
      take: SEARCH_RESULTS_LIMIT,
    });

    return students.map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      document: student.document,
      courseId: student.courseId,
      courseName: student.courseName,
      checkedIn: student.checkedIn,
      checkedInAt: student.checkedInAt,
      checkedInToday:
        student.checkedIn &&
        (!student.checkedInAt || localIsoDate(student.checkedInAt) === localIsoDate()),
      labelPrinted: student.labelPrinted,
      token: student.token,
      pendingConfirmation: isProvisionalStudentId(student.id),
    }));
  }

  /**
   * Lista as turmas já sincronizadas NESTA estação (distintas entre os
   * students da réplica local), para alimentar o seletor de turma da tela
   * de check-in — funciona totalmente offline, diferente de
   * `GET /pai/courses` (que consulta o banco do Pai ao vivo).
   */
  async listSyncedCourses(scope?: CourseScope): Promise<SyncedCourseSummary[]> {
    const students = await this.prisma.student.findMany({
      where: studentScopeWhere(scope),
      select: { courseId: true, courseName: true, syncedAt: true },
    });

    const byCourse = new Map<number, SyncedCourseSummary>();
    for (const student of students) {
      const existing = byCourse.get(student.courseId);
      if (existing) {
        existing.studentsCount += 1;
        if (student.syncedAt > existing.lastSyncedAt) {
          existing.lastSyncedAt = student.syncedAt;
        }
      } else {
        byCourse.set(student.courseId, {
          courseId: student.courseId,
          courseName: student.courseName,
          studentsCount: 1,
          lastSyncedAt: student.syncedAt,
        });
      }
    }

    return Array.from(byCourse.values()).sort((a, b) =>
      a.courseName.localeCompare(b.courseName),
    );
  }

  /**
   * Registra a presença do aluno (`checkedInAt` = presença mais recente).
   * Deve ser chamado dentro da MESMA transação que cria o print_job (quando
   * há etiqueta a imprimir) e o outbox_event do check-in, para que as
   * gravações sejam atômicas. `labelPrinted` marca a etiqueta como enviada
   * para impressão — nunca é desmarcada aqui.
   */
  async markCheckedIn(
    tx: LocalTransactionClient,
    studentId: number,
    checkedInAt: Date,
    labelPrinted = false,
  ): Promise<void> {
    await tx.student.update({
      where: { id: studentId },
      data: { checkedIn: true, checkedInAt, ...(labelPrinted ? { labelPrinted: true } : {}) },
    });
  }

  /**
   * Sincroniza (upsert) a réplica local de Student a partir do Checkin Pai.
   * Não sobrescreve o estado de check-in local (a réplica é "somente
   * cadastro"; quem manda no `checkedIn` é o próprio check-in local ou os
   * eventos recebidos via RabbitMQ).
   */
  async upsertMany(students: StudentReplicaDto[]): Promise<number> {
    let upserted = 0;

    for (const item of students) {
      await this.upsertOne(this.prisma, item);
      upserted += 1;
    }

    this.logger.log(`Réplica local de students sincronizada: ${upserted} registro(s).`);
    return upserted;
  }

  /**
   * Faz a réplica local de UMA turma ficar IGUAL ao Checkin Pai: grava
   * (upsert) os alunos recebidos e REMOVE da réplica os alunos dessa turma
   * que não vieram na lista (excluídos/movidos/invalidados no Pai — ex.:
   * "Excluir Alunos da Turma" seguido de novo upload gera ids novos, e os
   * antigos ficavam para sempre na busca do credenciamento).
   *
   * Tudo na MESMA transação: se algo falhar, a réplica volta ao estado
   * anterior em vez de ficar metade atualizada. A remoção roda ANTES dos
   * upserts para que um token reaproveitado por um aluno novo não colida
   * (índice único) com o registro antigo que está saindo.
   *
   * `print_jobs.student_id` é ON DELETE SET NULL: apagar o aluno não apaga
   * nem quebra o histórico de impressão.
   */
  async replaceCourse(
    courseId: number,
    students: StudentReplicaDto[],
  ): Promise<{ synced: number; removed: number }> {
    const keepIds = students.map((student) => student.id);

    const result = await this.prisma.$transaction(
      async (tx: LocalTransactionClient) => {
        // Alunos cadastrados nesta estação e ainda não confirmados pelo Pai
        // (id provisório) que JÁ apareceram no download: viram o registro
        // definitivo, preservando check-in e histórico de impressão.
        const provisionals = await tx.student.findMany({
          where: { id: { lt: 0 } },
          select: { token: true },
        });
        const incomingByToken = new Map(students.map((student) => [student.token, student.id]));
        for (const { token } of provisionals) {
          const realId = incomingByToken.get(token);
          if (realId !== undefined) {
            await this.promoteProvisionalByToken(tx, token, realId);
          }
        }

        // `id >= 0` poupa os provisórios que o Pai ainda não conhece — eles
        // não "sumiram" do Pai, só não chegaram lá ainda.
        const removed = await tx.student.deleteMany({
          where: { courseId, id: { notIn: keepIds, gte: 0 } },
        });

        for (const item of students) {
          await this.upsertOne(tx, item);
        }

        return { synced: students.length, removed: removed.count };
      },
      // Turmas grandes fazem milhares de upserts; o padrão do Prisma (5s) estoura.
      { timeout: 120000, maxWait: 10000 },
    );

    this.logger.log(
      `Réplica local da turma ${courseId} sincronizada: ${result.synced} registro(s), ${result.removed} removido(s).`,
    );
    return result;
  }

  private upsertOne(client: LocalTransactionClient | LocalPrismaService, item: StudentReplicaDto) {
    return client.student.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        courseId: item.courseId,
        courseName: item.courseName,
        courseEventDate: item.courseEventDate ?? null,
        courseEventDateEnd: item.courseEventDateEnd ?? null,
        courseEventType: item.courseEventType ?? null,
        courseCity: item.courseCity ?? null,
        name: item.name,
        token: item.token,
        email: item.email ?? null,
        document: item.document ?? null,
        ibcCustomerId: item.ibcCustomerId ?? null,
        labelPrinted: item.labelPrinted ?? false,
      },
      update: {
        courseId: item.courseId,
        courseName: item.courseName,
        courseEventDate: item.courseEventDate ?? null,
        courseEventDateEnd: item.courseEventDateEnd ?? null,
        courseEventType: item.courseEventType ?? null,
        // Consulta da cidade falhou (undefined) não apaga a cidade já gravada.
        ...(item.courseCity ? { courseCity: item.courseCity } : {}),
        name: item.name,
        token: item.token,
        email: item.email ?? null,
        document: item.document ?? null,
        ibcCustomerId: item.ibcCustomerId ?? null,
        // Só liga a flag: o Pai dizer "não impresso" não apaga uma impressão feita aqui.
        ...(item.labelPrinted ? { labelPrinted: true } : {}),
        syncedAt: new Date(),
      },
    });
  }

  /**
   * Aplica, de forma idempotente, um check-in ocorrido em OUTRA estação
   * (recebido via RabbitMQ). Só avança a presença se o evento for mais novo
   * que a presença local — evita regressão de estado sob entrega fora de
   * ordem — e aprende que a etiqueta já foi impressa.
   */
  async applyRemoteCheckin(payload: RemoteCheckinPayload): Promise<void> {
    // Ids provisórios (negativos) só valem na estação que cadastrou o aluno —
    // o mesmo número pode ser outro aluno aqui. O token é a chave global.
    // Para ids reais o id continua sendo a chave primária, com o token como
    // rede de segurança (evita colidir no índice único ao criar o registro mínimo).
    const existing =
      (isProvisionalStudentId(payload.id) ? null : await this.findById(payload.id)) ??
      (await this.findByToken(payload.token));

    if (existing) {
      // Evento de vários dias: vale a presença MAIS RECENTE; evento mais
      // antigo/repetido (entrega fora de ordem) não regride o estado.
      const isNewerPresence =
        !existing.checkedIn ||
        existing.checkedInAt === null ||
        payload.checkedInAt.getTime() > existing.checkedInAt.getTime();
      const learnsLabelPrinted = payload.labelPrinted === true && !existing.labelPrinted;

      if (!isNewerPresence && !learnsLabelPrinted) {
        return;
      }

      await this.prisma.student.update({
        where: { id: existing.id },
        data: {
          ...(isNewerPresence ? { checkedIn: true, checkedInAt: payload.checkedInAt } : {}),
          ...(learnsLabelPrinted ? { labelPrinted: true } : {}),
        },
      });
      return;
    }

    if (isProvisionalStudentId(payload.id)) {
      // Aluno cadastrado manualmente em outra estação e ainda não confirmado
      // pelo Pai: não há como criar um registro com id real agora. O
      // `student.create.completed` vai criá-lo aqui (sem o check-in — o Pai é
      // quem tem a verdade, e o próximo download da turma traz o estado final).
      this.logger.warn(
        `Check-in remoto de aluno ainda não confirmado pelo Pai ignorado (token ${payload.token}).`,
      );
      return;
    }

    // Aluno ainda não sincronizado localmente: cria um registro mínimo a
    // partir do próprio evento, para que o estado convirja mesmo assim.
    await this.prisma.student.create({
      data: {
        id: payload.id,
        courseId: payload.courseId,
        courseName: payload.courseName,
        name: payload.name,
        token: payload.token,
        checkedIn: true,
        checkedInAt: payload.checkedInAt,
        labelPrinted: payload.labelPrinted === true,
      },
    });
  }

  /**
   * Aplica IMEDIATAMENTE, na MESMA transação SQLite que cria o
   * `TicketTransfer`/`OutboxEvent` (ver TicketTransferService), os dados
   * do novo titular no aluno local — sem esperar o Checkin Pai/Coliseum
   * confirmarem nada. Isso é deliberado: numa transferência de ingresso
   * dentro de um evento, agilidade importa mais do que esperar a cadeia
   * completa Pocket → Pai → Coliseum responder (decisão de produto, ver
   * discussão da feature de transferência de ingresso).
   *
   * NÃO toca no `token`: só o Checkin Pai decide o token definitivo (ele
   * regenera ao confirmar a mudança de titularidade no Coliseum — ver
   * Student#handle_ownership_change no Pai). Se o Pocket decidisse um
   * token novo aqui, ele quase certamente divergiria do que o Pai gera
   * depois. O token atual continua válido até a confirmação assíncrona
   * (`transfer.completed`, ver StudentsService#applyRemoteTransfer)
   * trazer o definitivo — uma janela curta e aceita conscientemente em
   * troca de velocidade/resiliência offline.
   *
   * Usa `updateMany` (não upsert): só faz sentido atualizar um aluno que
   * esta estação já tem localmente. Se nunca sincronizou esse aluno, não
   * há como aplicar isso agora sem token nenhum — o registro será criado
   * pela confirmação assíncrona do Pai (que já traz o token real).
   */
  async applyLocalTransfer(
    tx: LocalTransactionClient,
    studentId: number,
    payload: LocalTransferPayload,
  ): Promise<boolean> {
    const result = await tx.student.updateMany({
      where: { id: studentId },
      data: {
        name: payload.name,
        email: payload.email,
        document: payload.document,
      },
    });
    return result.count > 0;
  }

  /**
   * Aplica, de forma idempotente, uma transferência de ingresso concluída
   * no Checkin Pai (recebida via RabbitMQ, evento `transfer.completed`).
   * Atualiza nome/e-mail/documento e — crucial — o `token`: o Pai regenera
   * o token do voucher sempre que a titularidade muda, então o QR físico
   * antigo deixa de funcionar a partir deste ponto em TODAS as estações.
   *
   * Faz UPSERT (não `updateMany`): esta estação pode nunca ter
   * sincronizado esse aluno localmente (turma nunca baixada aqui) — nesse
   * caso o resultado da transferência precisa aparecer mesmo assim, então
   * cria um registro mínimo a partir do próprio evento, igual a
   * `applyRemoteCheckin` já faz para check-ins remotos. `checkedIn` fica
   * `false` num registro novo: a transferência não implica que o novo
   * titular já passou pela credenciamento.
   */
  async applyRemoteTransfer(studentId: number, payload: RemoteTransferPayload): Promise<void> {
    await this.prisma.student.upsert({
      where: { id: studentId },
      update: {
        name: payload.name,
        email: payload.email,
        document: payload.document,
        token: payload.token,
      },
      create: {
        id: studentId,
        courseId: payload.courseId,
        courseName: payload.courseName ?? `Turma #${payload.courseId}`,
        name: payload.name,
        email: payload.email,
        document: payload.document,
        token: payload.token,
      },
    });
  }

  /**
   * Cria, DENTRO da transação do cadastro manual, o aluno local com id
   * provisório negativo (ver `isProvisionalStudentId`). O próximo id é
   * `min(ids existentes, 0) - 1`, dentro da mesma transação do SQLite, então
   * não há corrida entre dois cadastros simultâneos nesta estação.
   */
  async createProvisional(tx: LocalTransactionClient, data: ProvisionalStudentData): Promise<Student> {
    const lowest = await tx.student.aggregate({ _min: { id: true } });
    const provisionalId = Math.min(lowest._min.id ?? 0, 0) - 1;

    return tx.student.create({
      data: {
        id: provisionalId,
        courseId: data.courseId,
        courseName: data.courseName,
        courseEventDate: data.courseEventDate,
        courseEventDateEnd: data.courseEventDateEnd,
        courseEventType: data.courseEventType,
        name: data.name,
        token: data.token,
        email: data.email,
        document: data.document,
      },
    });
  }

  /**
   * Turma e janela do evento a partir da réplica local — o cadastro manual
   * só aceita turmas que esta estação já baixou (funciona offline e herda a
   * validação da janela de check-in, ver CheckinService#validateCourseWindow).
   */
  async findCourseContext(
    courseId: number,
  ): Promise<{
    courseName: string;
    courseEventDate: string | null;
    courseEventDateEnd: string | null;
    courseEventType: string | null;
  } | null> {
    // `desc` põe primeiro um aluno COM tipo de turma (no SQLite, nulos vêm por último em desc).
    const sample = await this.prisma.student.findFirst({
      where: { courseId },
      orderBy: { courseEventType: 'desc' },
      select: { courseName: true, courseEventDate: true, courseEventDateEnd: true, courseEventType: true },
    });
    return sample;
  }

  /**
   * Cidade do evento de uma turma a partir da réplica local: alunos criados
   * aqui (cadastro manual) ou por outra estação nascem sem `courseCity`, mas
   * os demais alunos da mesma turma, baixados do Pai, a têm.
   */
  async findCourseCity(courseId: number): Promise<string | null> {
    const sample = await this.prisma.student.findFirst({
      where: { courseId, courseCity: { not: null } },
      select: { courseCity: true },
    });
    return sample?.courseCity ?? null;
  }

  /** Procura um aluno por documento dentro de uma turma (detecção de duplicidade no cadastro manual). */
  findByDocumentInCourse(courseId: number, document: string): Promise<Student | null> {
    return this.prisma.student.findFirst({ where: { courseId, document } });
  }

  /**
   * Aplica o `student.create.completed` do Pai: troca o id provisório pelo
   * definitivo (preservando check-in e print_jobs, que acompanham por
   * `ON UPDATE CASCADE`) ou, em outra estação, cria o aluno. Idempotente:
   * reentrega da mesma mensagem não muda nada.
   */
  async applyRemoteStudentCreated(payload: RemoteStudentCreatedPayload): Promise<void> {
    await this.prisma.$transaction(async (tx: LocalTransactionClient) => {
      await this.promoteProvisionalByToken(tx, payload.token, payload.id);

      const data = {
        courseId: payload.courseId,
        name: payload.name,
        token: payload.token,
        email: payload.email,
        document: payload.document,
        ibcCustomerId: payload.ibcCustomerId,
      };

      const existingByToken = await tx.student.findUnique({ where: { token: payload.token } });
      if (existingByToken && existingByToken.id !== payload.id) {
        // O token já pertence a outro registro local (id diferente do que o
        // Pai informou): não dá para criar sem violar o índice único. O
        // próximo download da turma reconcilia — registra e segue.
        this.logger.warn(
          `Token ${payload.token} já existe localmente com id ${existingByToken.id} (Pai informou ${payload.id}); aguardando o próximo download da turma.`,
        );
        return;
      }

      await tx.student.upsert({
        where: { id: payload.id },
        update: {
          ...data,
          ...(payload.courseName ? { courseName: payload.courseName } : {}),
          ...(payload.courseEventType ? { courseEventType: payload.courseEventType } : {}),
          syncedAt: new Date(),
        },
        create: {
          id: payload.id,
          ...data,
          courseName: payload.courseName ?? `Turma #${payload.courseId}`,
          courseEventType: payload.courseEventType ?? null,
        },
      });
    });
  }

  /**
   * Se existe um aluno PROVISÓRIO (id negativo) com este token, passa a ter
   * o id definitivo do Pai — atualizando o id in place para manter
   * `checked_in` e os `print_jobs` (FK com ON UPDATE CASCADE). Se o id
   * definitivo já existe por outro caminho, descarta o provisório para não
   * colidir no índice único do token.
   */
  private async promoteProvisionalByToken(
    tx: LocalTransactionClient,
    token: string,
    realId: number,
  ): Promise<void> {
    const provisional = await tx.student.findUnique({ where: { token } });
    if (!provisional || !isProvisionalStudentId(provisional.id)) {
      return;
    }

    const realAlreadyExists = await tx.student.findUnique({ where: { id: realId } });
    if (realAlreadyExists) {
      await tx.student.delete({ where: { id: provisional.id } });
      return;
    }

    await tx.student.update({ where: { id: provisional.id }, data: { id: realId } });
  }
}
