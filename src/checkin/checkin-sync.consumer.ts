import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  CHECKIN_PERFORMED_BINDING_PATTERN,
  CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
  STATION_QUEUE_EXPIRES_MS,
  checkinSyncDeadLetterQueueName,
  checkinSyncQueueName,
} from '../messaging/rabbitmq.constants';
import { parseCheckinPerformedMessage } from '../messaging/types';
import { StudentsService } from '../students/students.service';

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
 * O setup NUNCA trava o boot do Nest por causa de um broker indisponível: ele
 * é entregue ao RabbitMqService (`registerConsumer`), que o executa quando a
 * conexão sobe e de novo a CADA reconexão — a fila continua sendo consumida
 * depois de quedas de rede, sem precisar reabrir o app.
 */
@Injectable()
export class CheckinSyncConsumer implements OnModuleInit {
  private readonly logger = new Logger(CheckinSyncConsumer.name);

  constructor(
    private readonly rabbitMq: RabbitMqService,
    private readonly studentsService: StudentsService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  onModuleInit(): void {
    const queue = checkinSyncQueueName(this.agentKey);
    this.rabbitMq.registerConsumer(queue, () => this.setup(queue));
  }

  private async setup(queue: string): Promise<void> {
    await this.rabbitMq.assertAndBindQueue(
      checkinSyncDeadLetterQueueName(this.agentKey),
      CHECKIN_EVENTS_EXCHANGE_DLX,
      CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
      { arguments: { 'x-expires': STATION_QUEUE_EXPIRES_MS } },
    );

    await this.rabbitMq.assertAndBindQueue(queue, CHECKIN_EVENTS_EXCHANGE, CHECKIN_PERFORMED_BINDING_PATTERN, {
      arguments: {
        'x-dead-letter-exchange': CHECKIN_EVENTS_EXCHANGE_DLX,
        'x-dead-letter-routing-key': CHECKIN_PERFORMED_DEAD_ROUTING_KEY,
        'x-expires': STATION_QUEUE_EXPIRES_MS,
      },
    });

    await this.rabbitMq.consume(queue, (content) => this.handleMessage(content));
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
