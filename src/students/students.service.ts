import { Injectable, Logger } from '@nestjs/common';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { Student } from '../../generated/prisma-local';
import { StudentReplicaDto } from './dto/upsert-students.dto';

export interface RemoteCheckinPayload {
  id: number;
  name: string;
  courseId: number;
  courseName: string;
  token: string;
  checkedInAt: Date;
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
  token: string;
}

const SEARCH_RESULTS_LIMIT = 15;

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
  async search(query: string): Promise<StudentSearchResult[]> {
    const term = query.trim();
    if (term.length < 2) {
      return [];
    }

    const students = await this.prisma.student.findMany({
      where: {
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
      token: student.token,
    }));
  }

  /**
   * Lista as turmas já sincronizadas NESTA estação (distintas entre os
   * students da réplica local), para alimentar o seletor de turma da tela
   * de check-in — funciona totalmente offline, diferente de
   * `GET /pai/courses` (que consulta o banco do Pai ao vivo).
   */
  async listSyncedCourses(): Promise<SyncedCourseSummary[]> {
    const students = await this.prisma.student.findMany({
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
   * Marca o aluno como credenciado. Deve ser chamado dentro da MESMA
   * transação que cria o print_job e o outbox_event do check-in, para que
   * as três gravações sejam atômicas.
   */
  async markCheckedIn(
    tx: LocalTransactionClient,
    studentId: number,
    checkedInAt: Date,
  ): Promise<void> {
    await tx.student.update({
      where: { id: studentId },
      data: { checkedIn: true, checkedInAt },
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
      await this.prisma.student.upsert({
        where: { id: item.id },
        create: {
          id: item.id,
          courseId: item.courseId,
          courseName: item.courseName,
          courseEventDate: item.courseEventDate ?? null,
          courseEventDateEnd: item.courseEventDateEnd ?? null,
          name: item.name,
          token: item.token,
          email: item.email ?? null,
          document: item.document ?? null,
          ibcCustomerId: item.ibcCustomerId ?? null,
        },
        update: {
          courseId: item.courseId,
          courseName: item.courseName,
          courseEventDate: item.courseEventDate ?? null,
          courseEventDateEnd: item.courseEventDateEnd ?? null,
          name: item.name,
          token: item.token,
          email: item.email ?? null,
          document: item.document ?? null,
          ibcCustomerId: item.ibcCustomerId ?? null,
          syncedAt: new Date(),
        },
      });
      upserted += 1;
    }

    this.logger.log(`Réplica local de students sincronizada: ${upserted} registro(s).`);
    return upserted;
  }

  /**
   * Aplica, de forma idempotente, um check-in ocorrido em OUTRA estação
   * (recebido via RabbitMQ). Se o aluno já estiver marcado como
   * credenciado com um horário igual ou anterior, não faz nada — evita
   * regressão de estado sob entrega fora de ordem.
   */
  async applyRemoteCheckin(payload: RemoteCheckinPayload): Promise<void> {
    const existing = await this.findById(payload.id);

    if (existing) {
      const alreadyUpToDate =
        existing.checkedIn &&
        existing.checkedInAt !== null &&
        existing.checkedInAt.getTime() <= payload.checkedInAt.getTime();

      if (alreadyUpToDate) {
        return;
      }

      await this.prisma.student.update({
        where: { id: payload.id },
        data: { checkedIn: true, checkedInAt: payload.checkedInAt },
      });
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
}
