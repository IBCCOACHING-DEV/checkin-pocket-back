import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { RemotePaiPrismaService } from '../database/remote-prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { StudentsService } from '../students/students.service';
import { CourseScope, isCourseAllowed } from '../auth/course-scope';
import { TRANSFER_REQUESTED_ROUTING_KEY } from '../messaging/rabbitmq.constants';
import { TransferRequestedMessage } from '../messaging/types';
import { RequestTransferDto } from './dto/request-transfer.dto';
import { TransferSearchResult } from './interfaces/transfer-search-result.interface';
import { TransferStatus } from './interfaces/transfer-status.interface';
import { buildOwnerSearchFilter } from './transfer-search-filter';

const TRANSFER_SEARCH_LIMIT = 30;

function latestDate(a: Date | null, b: Date | null): Date | null {
  if (a && b) {
    return a.getTime() >= b.getTime() ? a : b;
  }
  return a ?? b;
}

/**
 * Transferência de ingresso — SÍNCRONA no que depende desta estação,
 * ASSÍNCRONA em relação aos demais sistemas (decisão de produto: ver
 * discussão da feature — agilidade no evento importa mais do que esperar
 * a cadeia completa Pocket → Pai → Coliseum responder, e essa janela de
 * inconsistência é aceita conscientemente em troca de resiliência/
 * velocidade offline).
 *
 * `requestTransfer` faz TUDO isto na MESMA transação SQLite local:
 *  1) cria o `TicketTransfer` (rastreio do pedido)
 *  2) atualiza nome/e-mail/documento do `Student` local JÁ — ver
 *     StudentsService#applyLocalTransfer (não toca no token: só o Checkin
 *     Pai decide o token definitivo)
 *  3) grava o `OutboxEvent` de `transfer.requested`
 *
 * Só depois disso o OutboxPublisherWorker publica no RabbitMQ, o Checkin
 * Pai processa no Coliseum e devolve `transfer.completed` — que aí sim
 * traz o token definitivo e confirma/corrige os dados em todas as
 * estações (ver TicketTransferSyncConsumer).
 */
@Injectable()
export class TicketTransferService {
  private readonly logger = new Logger(TicketTransferService.name);

  constructor(
    private readonly prisma: LocalPrismaService,
    private readonly remotePrisma: RemotePaiPrismaService,
    private readonly outboxService: OutboxService,
    private readonly studentsService: StudentsService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  /**
   * Busca o(s) ingresso(s) por CPF (inteiro ou parcial), nome ou e-mail do
   * titular atual diretamente no banco do Pai (MySQL, somente leitura) — não
   * depende da réplica local, então funciona mesmo para turmas que esta
   * estação nunca sincronizou. Ver `buildOwnerSearchFilter` para como o
   * termo é interpretado.
   *
   * Só considera ingressos de turmas ATIVAS (`Course.status = true`, mesmo
   * critério de `PaiSyncService#listActiveCourses`): transferir ingresso de
   * uma turma encerrada não faz sentido no credenciamento do evento. Para
   * operador restrito (staff/user com tipo event/formation), também só do
   * mesmo `event_type`, como na CoursePolicy::Scope do Pai.
   *
   * Cada resultado diz se o titular atual JÁ FOI CREDENCIADO: vale a presença
   * gravada no Pai (`checkin_date`) ou a registrada nesta estação (que pode
   * ainda não ter chegado ao Pai pelo RabbitMQ).
   */
  async search(query: string, scope?: CourseScope): Promise<TransferSearchResult[]> {
    const students = await this.queryPai(() =>
      this.remotePrisma.client.student.findMany({
        where: {
          OR: buildOwnerSearchFilter(query),
          course: { is: { status: true, ...(scope?.eventType ? { eventType: scope.eventType } : {}) } },
        },
        include: { course: true },
        orderBy: { name: 'asc' },
        take: TRANSFER_SEARCH_LIMIT,
      }),
    );

    const localStates = await this.studentsService.findCheckinStates(students.map((student) => student.id));

    return students.map((student) => {
      const local = localStates.get(student.id);
      const paiCheckinAt = student.checkinDate ?? null;
      const localCheckinAt = local?.checkedIn ? local.checkedInAt : null;

      return {
        studentId: student.id,
        courseId: student.courseId ?? 0,
        courseName: student.course?.name ?? `Turma #${student.courseId ?? '?'}`,
        currentOwnerName: student.name,
        currentOwnerEmail: student.email,
        currentOwnerDocument: student.document,
        checkedIn: paiCheckinAt !== null || local?.checkedIn === true,
        checkedInAt: latestDate(paiCheckinAt, localCheckinAt),
      };
    });
  }

  /**
   * Cria a solicitação de transferência, atualiza o aluno local JÁ e
   * devolve o controle IMEDIATAMENTE — tudo em uma única transação SQLite
   * local (milissegundos). A chamada ao Coliseum acontece em background,
   * no Checkin Pai, depois que o OutboxPublisherWorker publicar o evento
   * no RabbitMQ.
   */
  async requestTransfer(dto: RequestTransferDto, scope?: CourseScope): Promise<TransferStatus> {
    await this.assertCourseAllowed(dto.courseId, scope);

    return this.prisma.$transaction(async (tx: LocalTransactionClient) => {
      const transfer = await tx.ticketTransfer.create({
        data: {
          studentId: dto.studentId,
          courseId: dto.courseId,
          status: 'pending',
          requestedName: dto.name,
          requestedEmail: dto.email,
          requestedPhone: dto.phone,
          requestedDocument: dto.document ?? null,
          requestedNickName: dto.nickName ?? null,
          requestedNote: dto.note ?? null,
          sourceAgentKey: this.agentKey,
        },
      });

      const appliedLocally = await this.studentsService.applyLocalTransfer(tx, dto.studentId, {
        name: dto.name,
        email: dto.email,
        document: dto.document ?? null,
      });

      const message: TransferRequestedMessage = {
        eventId: transfer.id,
        studentId: dto.studentId,
        courseId: dto.courseId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        document: dto.document,
        nickName: dto.nickName,
        note: dto.note,
        sourceAgentKey: this.agentKey,
        occurredAt: new Date().toISOString(),
      };

      await this.outboxService.record(tx, {
        aggregateType: 'ticket_transfer',
        aggregateId: transfer.id,
        eventType: 'transfer.requested',
        routingKey: TRANSFER_REQUESTED_ROUTING_KEY,
        payload: message,
      });

      this.logger.log(
        `Transferência solicitada — id=${transfer.id} aluno=${dto.studentId} turma=${dto.courseId} ` +
          `(atualizado localmente=${appliedLocally}). Aguardando confirmação assíncrona do Checkin Pai.`,
      );

      return this.toStatus(transfer, appliedLocally);
    });
  }

  async getStatus(id: string): Promise<TransferStatus> {
    const transfer = await this.prisma.ticketTransfer.findUnique({ where: { id } });
    if (!transfer) {
      throw new NotFoundException(`Transferência ${id} não encontrada.`);
    }
    return this.toStatus(transfer);
  }

  /**
   * Aplica o resultado de uma transferência (recebido via RabbitMQ) ao
   * registro local — SÓ existe um `TicketTransfer` com este `eventId`
   * na estação que originou a solicitação; nas demais estações este
   * método é um no-op silencioso (elas só atualizam a réplica do Student,
   * ver StudentsService#applyRemoteTransfer).
   */
  async applyResult(eventId: string, success: boolean, errorMessage?: string): Promise<void> {
    await this.prisma.ticketTransfer.updateMany({
      where: { id: eventId, status: 'pending' },
      data: {
        status: success ? 'completed' : 'failed',
        errorMessage: errorMessage ?? null,
        resolvedAt: new Date(),
      },
    });
  }

  private toStatus(
    transfer: {
      id: string;
      status: string;
      studentId: number;
      courseId: number;
      errorMessage: string | null;
      createdAt: Date;
      resolvedAt: Date | null;
    },
    appliedLocally?: boolean,
  ): TransferStatus {
    return {
      id: transfer.id,
      status: transfer.status,
      studentId: transfer.studentId,
      courseId: transfer.courseId,
      errorMessage: transfer.errorMessage,
      createdAt: transfer.createdAt,
      resolvedAt: transfer.resolvedAt,
      appliedLocally,
    };
  }

  /**
   * Barra a solicitação de operador restrito para turma fora do seu perfil
   * (a busca já filtra; isto cobre chamadas diretas à API). Só consulta o
   * tipo da turma quando há restrição; usa o Pai (fonte da verdade) e, se
   * estiver inalcançável, o tipo guardado na réplica local.
   */
  private async assertCourseAllowed(courseId: number, scope?: CourseScope): Promise<void> {
    if (!scope?.eventType) {
      return;
    }

    let courseEventType: string | null | undefined;
    try {
      const course = await this.remotePrisma.client.course.findUnique({
        where: { id: courseId },
        select: { eventType: true },
      });
      courseEventType = course?.eventType;
    } catch {
      courseEventType = (await this.studentsService.findCourseContext(courseId))?.courseEventType;
    }

    if (!isCourseAllowed(scope, courseEventType)) {
      throw new ForbiddenException('Este ingresso pertence a uma turma fora do seu perfil de acesso.');
    }
  }

  private async queryPai<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Falha ao consultar o banco do Checkin Pai: ${message}`);
      throw new ServiceUnavailableException(
        'Não foi possível conectar ao banco do Checkin Pai agora. Verifique a rede e tente novamente.',
      );
    }
  }
}
