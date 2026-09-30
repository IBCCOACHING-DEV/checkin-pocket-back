import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { RemotePaiPrismaService } from '../database/remote-prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { StudentsService } from '../students/students.service';
import { TRANSFER_REQUESTED_ROUTING_KEY } from '../messaging/rabbitmq.constants';
import { TransferRequestedMessage } from '../messaging/types';
import { RequestTransferDto } from './dto/request-transfer.dto';
import { TransferSearchResult } from './interfaces/transfer-search-result.interface';
import { TransferStatus } from './interfaces/transfer-status.interface';

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
   * Busca o(s) ingresso(s) associados a um CPF diretamente no banco do
   * Pai (MySQL, somente leitura) — não depende da réplica local, então
   * funciona mesmo para turmas que esta estação nunca sincronizou.
   */
  async searchByDocument(document: string): Promise<TransferSearchResult[]> {
    const cleanedDocument = document.replace(/\D/g, '');

    const students = await this.queryPai(() =>
      this.remotePrisma.client.student.findMany({
        where: { document: cleanedDocument },
        include: { course: true },
      }),
    );

    return students
      .filter((student) => student.id !== undefined)
      .map((student) => ({
        studentId: student.id,
        courseId: student.courseId ?? 0,
        courseName: student.course?.name ?? `Turma #${student.courseId ?? '?'}`,
        currentOwnerName: student.name,
        currentOwnerEmail: student.email,
        currentOwnerDocument: student.document,
      }));
  }

  /**
   * Cria a solicitação de transferência, atualiza o aluno local JÁ e
   * devolve o controle IMEDIATAMENTE — tudo em uma única transação SQLite
   * local (milissegundos). A chamada ao Coliseum acontece em background,
   * no Checkin Pai, depois que o OutboxPublisherWorker publicar o evento
   * no RabbitMQ.
   */
  async requestTransfer(dto: RequestTransferDto): Promise<TransferStatus> {
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
