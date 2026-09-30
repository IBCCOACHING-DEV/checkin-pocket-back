import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  TRANSFER_COMPLETED_DEAD_ROUTING_KEY,
  TRANSFER_COMPLETED_ROUTING_KEY,
  transferSyncDeadLetterQueueName,
  transferSyncQueueName,
} from '../messaging/rabbitmq.constants';
import { parseTransferCompletedMessage } from '../messaging/types';
import { StudentsService } from '../students/students.service';
import { TicketTransferService } from './ticket-transfer.service';

const REGISTER_RETRY_INTERVAL_MS = 15000;

/**
 * Consumer do RabbitMQ que escuta `transfer.completed` — publicado pelo
 * Checkin Pai depois de processar uma solicitação de transferência (ver
 * TicketTransferService#requestTransfer, que só grava e publica
 * `transfer.requested`, sem esperar resposta).
 *
 * TODAS as estações recebem uma cópia (fan-out via topic exchange, fila
 * própria por agente — mesmo padrão do CheckinSyncConsumer, mas em uma
 * fila SEPARADA: misturar `checkin.performed` e `transfer.completed` na
 * mesma fila dividiria as mensagens entre os dois consumers em vez de
 * cada um receber só o que sabe processar).
 *
 * Duas responsabilidades por mensagem, independentes entre si:
 *  1) Atualizar a réplica local do Student (nome/e-mail/documento/token)
 *     — em TODAS as estações, se `success` for true.
 *  2) Resolver o `TicketTransfer` local pendente (por `eventId`) — só
 *     tem efeito na estação que originou a solicitação; nas demais é
 *     um no-op silencioso (ver TicketTransferService#applyResult).
 */
@Injectable()
export class TicketTransferSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TicketTransferSyncConsumer.name);
  private stopped = false;
  private registered = false;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rabbitMq: RabbitMqService,
    private readonly studentsService: StudentsService,
    private readonly ticketTransferService: TicketTransferService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  onModuleInit(): void {
    // Fire-and-forget deliberado — ver CheckinSyncConsumer para a
    // justificativa (boot do Nest não pode depender do broker estar de pé).
    void this.registerLoop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
  }

  private async registerLoop(): Promise<void> {
    while (!this.stopped && !this.registered) {
      const success = await this.tryRegister();

      if (success || this.stopped) {
        return;
      }

      await this.sleep(REGISTER_RETRY_INTERVAL_MS);
    }
  }

  private async tryRegister(): Promise<boolean> {
    const queue = transferSyncQueueName(this.agentKey);
    const deadLetterQueue = transferSyncDeadLetterQueueName(this.agentKey);

    try {
      await this.rabbitMq.assertAndBindQueue(
        deadLetterQueue,
        CHECKIN_EVENTS_EXCHANGE_DLX,
        TRANSFER_COMPLETED_DEAD_ROUTING_KEY,
      );

      await this.rabbitMq.assertAndBindQueue(queue, CHECKIN_EVENTS_EXCHANGE, TRANSFER_COMPLETED_ROUTING_KEY, {
        arguments: {
          'x-dead-letter-exchange': CHECKIN_EVENTS_EXCHANGE_DLX,
          'x-dead-letter-routing-key': TRANSFER_COMPLETED_DEAD_ROUTING_KEY,
        },
      });

      await this.rabbitMq.consume(queue, (content) => this.handleMessage(content));

      this.registered = true;
      this.logger.log(`Sincronização de transferências de ingresso ativa (fila "${queue}").`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Não foi possível registrar o consumer de transferências (broker indisponível?): ${message}. Nova tentativa em ${REGISTER_RETRY_INTERVAL_MS}ms.`,
      );
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pendingTimeout = setTimeout(resolve, ms);
    });
  }

  private async handleMessage(content: Buffer): Promise<void> {
    const raw: unknown = JSON.parse(content.toString('utf8'));
    const message = parseTransferCompletedMessage(raw);

    if (message.success && message.student) {
      await this.studentsService.applyRemoteTransfer(message.studentId, message.student);
    }

    await this.ticketTransferService.applyResult(message.eventId, message.success, message.errorMessage);

    this.logger.log(
      `Transferência sincronizada — evento=${message.eventId} aluno=${message.studentId} success=${message.success}.`,
    );
  }
}
