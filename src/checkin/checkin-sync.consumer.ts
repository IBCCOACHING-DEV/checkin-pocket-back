import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  CHECKIN_PERFORMED_BINDING_PATTERN,
  CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
  checkinSyncDeadLetterQueueName,
  checkinSyncQueueName,
} from '../messaging/rabbitmq.constants';
import { parseCheckinPerformedMessage } from '../messaging/types';
import { StudentsService } from '../students/students.service';

const REGISTER_RETRY_INTERVAL_MS = 15000;

/**
 * Consumer (listener) do RabbitMQ que escuta a fila de check-ins de OUTROS
 * computadores da rede (outras instâncias do Checkin Pocket) e atualiza a
 * base local do SQLite para refletir que o aluno já foi credenciado.
 *
 * Cada instância declara sua PRÓPRIA fila, ligada por padrão de roteamento
 * ("checkin.#") ao exchange topic compartilhado `ibc.checkin.events` — isso
 * garante que TODAS as instâncias recebam uma cópia de cada evento
 * publicado por qualquer uma delas (fan-out), e não apenas uma disputando
 * mensagens entre si.
 *
 * Eventos originados nesta própria estação (mesmo agentKey) são ignorados,
 * pois o check-in local já aplicou a mudança de estado diretamente.
 *
 * Assim como o AuthSyncService (banco do Pai), o setup deste consumer NUNCA
 * pode travar/derrubar o boot do Nest por causa de um broker indisponível
 * (RabbitMQ pode não estar de pé ainda, ou nem existir em um teste local) —
 * por isso `onModuleInit` dispara um loop de retry em background em vez de
 * aguardar `assertAndBindQueue`/`consume` diretamente.
 */
@Injectable()
export class CheckinSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckinSyncConsumer.name);
  private stopped = false;
  private registered = false;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rabbitMq: RabbitMqService,
    private readonly studentsService: StudentsService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  onModuleInit(): void {
    // Fire-and-forget deliberado: NÃO aguardamos esta Promise para não
    // bloquear o bootstrap do Nest enquanto o RabbitMQ estiver indisponível.
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
    const queue = checkinSyncQueueName(this.agentKey);
    const deadLetterQueue = checkinSyncDeadLetterQueueName(this.agentKey);

    try {
      await this.rabbitMq.assertAndBindQueue(
        deadLetterQueue,
        CHECKIN_EVENTS_EXCHANGE_DLX,
        CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
      );

      await this.rabbitMq.assertAndBindQueue(
        queue,
        CHECKIN_EVENTS_EXCHANGE,
        CHECKIN_PERFORMED_BINDING_PATTERN,
        {
          arguments: {
            'x-dead-letter-exchange': CHECKIN_EVENTS_EXCHANGE_DLX,
            'x-dead-letter-routing-key': CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
          },
        },
      );

      await this.rabbitMq.consume(queue, (content) => this.handleMessage(content));

      this.registered = true;
      this.logger.log(`Sincronização de check-ins remotos ativa (fila "${queue}").`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Não foi possível registrar o consumer de check-ins remotos (broker indisponível?): ${message}. Nova tentativa em ${REGISTER_RETRY_INTERVAL_MS}ms.`,
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
    const message = parseCheckinPerformedMessage(raw);

    if (message.sourceAgentKey === this.agentKey) {
      this.logger.debug(`Ignorando eco do próprio check-in (evento ${message.eventId}).`);
      return;
    }

    await this.studentsService.applyRemoteCheckin({
      id: message.studentId,
      name: message.studentName,
      courseId: message.courseId,
      courseName: message.courseName,
      token: message.studentToken,
      checkedInAt: new Date(message.checkedInAt),
      labelPrinted: message.labelPrinted ?? true,
    });

    this.logger.log(
      `Check-in remoto sincronizado — aluno=${message.studentId} origem=${message.sourceAgentKey}.`,
    );
  }
}
