import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  STATION_QUEUE_EXPIRES_MS,
  STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
  STUDENT_CREATE_COMPLETED_ROUTING_KEY,
  studentSyncDeadLetterQueueName,
  studentSyncQueueName,
} from '../messaging/rabbitmq.constants';
import { parseStudentCreateCompletedMessage } from '../messaging/types';
import { StudentsService } from '../students/students.service';
import { StudentRegistrationService } from './student-registration.service';

/**
 * Consumer do RabbitMQ que escuta `student.create.completed` — publicado
 * pelo Checkin Pai depois de criar (ou recusar) um aluno cadastrado
 * manualmente (ver StudentRegistrationService#register, que só grava local
 * e publica `student.create.requested`, sem esperar resposta).
 *
 * TODAS as estações recebem uma cópia (fan-out via topic exchange, fila
 * própria por agente, SEPARADA das filas de check-in e de transferência: um
 * consumer por fila, cada um só com o que sabe processar).
 *
 * Duas responsabilidades por mensagem, independentes entre si:
 *  1) Se `success`: aplicar o aluno na réplica local — troca o id provisório
 *     pelo definitivo na estação de origem e cria o aluno nas demais (ver
 *     StudentsService#applyRemoteStudentCreated).
 *  2) Resolver o `StudentRegistration` local pendente (por `eventId`) — só
 *     tem efeito na estação de origem; nas demais é um no-op silencioso.
 *
 * Se o Pai RECUSAR (`success = false`), o aluno provisório continua na
 * estação de origem (ele pode já ter sido credenciado e ter crachá impresso)
 * e o registro fica `failed` com o motivo, para a equipe resolver no Pai.
 */
@Injectable()
export class StudentCreateSyncConsumer implements OnModuleInit {
  private readonly logger = new Logger(StudentCreateSyncConsumer.name);

  constructor(
    private readonly rabbitMq: RabbitMqService,
    private readonly studentsService: StudentsService,
    private readonly registrationService: StudentRegistrationService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  onModuleInit(): void {
    // Montado e remontado a cada (re)conexão pelo RabbitMqService — ver CheckinSyncConsumer.
    const queue = studentSyncQueueName(this.agentKey);
    this.rabbitMq.registerConsumer(queue, () => this.setup(queue));
  }

  private async setup(queue: string): Promise<void> {
    await this.rabbitMq.assertAndBindQueue(
      studentSyncDeadLetterQueueName(this.agentKey),
      CHECKIN_EVENTS_EXCHANGE_DLX,
      STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
      { arguments: { 'x-expires': STATION_QUEUE_EXPIRES_MS } },
    );

    await this.rabbitMq.assertAndBindQueue(queue, CHECKIN_EVENTS_EXCHANGE, STUDENT_CREATE_COMPLETED_ROUTING_KEY, {
      arguments: {
        'x-dead-letter-exchange': CHECKIN_EVENTS_EXCHANGE_DLX,
        'x-dead-letter-routing-key': STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
        'x-expires': STATION_QUEUE_EXPIRES_MS,
      },
    });

    await this.rabbitMq.consume(queue, (content) => this.handleMessage(content));
  }

  private async handleMessage(content: Buffer): Promise<void> {
    const raw: unknown = JSON.parse(content.toString('utf8'));
    const message = parseStudentCreateCompletedMessage(raw);

    if (message.success && message.student) {
      await this.studentsService.applyRemoteStudentCreated(message.student);
    }

    await this.registrationService.applyResult(
      message.eventId,
      message.success,
      message.errorMessage,
      message.student?.id,
    );

    this.logger.log(
      `Cadastro de aluno sincronizado — evento=${message.eventId} success=${message.success}.`,
    );
  }
}
