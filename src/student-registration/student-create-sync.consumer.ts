import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
  STUDENT_CREATE_COMPLETED_ROUTING_KEY,
  studentSyncDeadLetterQueueName,
  studentSyncQueueName,
} from '../messaging/rabbitmq.constants';
import { parseStudentCreateCompletedMessage } from '../messaging/types';
import { StudentsService } from '../students/students.service';
import { StudentRegistrationService } from './student-registration.service';

const REGISTER_RETRY_INTERVAL_MS = 15000;

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
export class StudentCreateSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StudentCreateSyncConsumer.name);
  private stopped = false;
  private registered = false;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

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
    const queue = studentSyncQueueName(this.agentKey);
    const deadLetterQueue = studentSyncDeadLetterQueueName(this.agentKey);

    try {
      await this.rabbitMq.assertAndBindQueue(
        deadLetterQueue,
        CHECKIN_EVENTS_EXCHANGE_DLX,
        STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
      );

      await this.rabbitMq.assertAndBindQueue(queue, CHECKIN_EVENTS_EXCHANGE, STUDENT_CREATE_COMPLETED_ROUTING_KEY, {
        arguments: {
          'x-dead-letter-exchange': CHECKIN_EVENTS_EXCHANGE_DLX,
          'x-dead-letter-routing-key': STUDENT_CREATE_COMPLETED_DEAD_ROUTING_KEY,
        },
      });

      await this.rabbitMq.consume(queue, (content) => this.handleMessage(content));

      this.registered = true;
      this.logger.log(`Sincronização de cadastros de aluno ativa (fila "${queue}").`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Não foi possível registrar o consumer de cadastros de aluno (broker indisponível?): ${message}. Nova tentativa em ${REGISTER_RETRY_INTERVAL_MS}ms.`,
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
