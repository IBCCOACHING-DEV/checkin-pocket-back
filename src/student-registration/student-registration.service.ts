import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { OutboxService } from '../outbox/outbox.service';
import { StudentsService } from '../students/students.service';
import { CourseScope, isCourseAllowed } from '../auth/course-scope';
import { STUDENT_CREATE_REQUESTED_ROUTING_KEY } from '../messaging/rabbitmq.constants';
import { StudentCreateRequestedMessage } from '../messaging/types';
import { RegisterStudentDto } from './dto/register-student.dto';
import { RegistrationStatus } from './interfaces/registration-status.interface';

function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value ? squish(value) : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Cadastro manual de aluno — mesmo propósito do formulário de cortesia do
 * Checkin Pai, em DUAS etapas:
 *
 *  1) SÍNCRONA (esta classe, `register`): em UMA transação SQLite local cria
 *     o `Student` (id provisório negativo + token UUID gerado aqui), o
 *     `StudentRegistration` (rastreio) e o `OutboxEvent` de
 *     `student.create.requested`. Responde em milissegundos e funciona
 *     offline — o aluno já pode ser credenciado e ter o crachá impresso.
 *  2) ASSÍNCRONA: o OutboxPublisherWorker publica no RabbitMQ, o Checkin Pai
 *     cria o Student lá com o MESMO token e devolve `student.create.completed`
 *     (ver StudentCreateSyncConsumer), que troca o id provisório pelo real.
 *
 * Igual ao cadastro de cortesia do Pai, NÃO cria cliente no Coliseum
 * (`ibc_customer_id` fica nulo) — é um registro, não uma venda.
 */
@Injectable()
export class StudentRegistrationService {
  private readonly logger = new Logger(StudentRegistrationService.name);

  constructor(
    private readonly prisma: LocalPrismaService,
    private readonly outboxService: OutboxService,
    private readonly studentsService: StudentsService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  async register(dto: RegisterStudentDto, scope?: CourseScope): Promise<RegistrationStatus> {
    const course = await this.studentsService.findCourseContext(dto.courseId);
    if (!course) {
      throw new NotFoundException(
        'Esta turma ainda não foi baixada nesta estação. Abra "Atualizar turmas" e baixe a turma antes de cadastrar o aluno.',
      );
    }

    if (!isCourseAllowed(scope, course.courseEventType)) {
      throw new ForbiddenException(
        'Esta turma está fora do seu perfil de acesso. Se ela for do seu perfil, use "Atualizar turmas" e tente de novo.',
      );
    }

    const document = dto.document.replace(/\D/g, '');
    if (!document) {
      throw new BadRequestException('Informe o CPF do aluno.');
    }

    const duplicate = await this.studentsService.findByDocumentInCourse(dto.courseId, document);
    if (duplicate) {
      throw new ConflictException(
        `Já existe um aluno com este CPF nesta turma (${duplicate.name}). Use a busca do credenciamento.`,
      );
    }

    // Mesma limpeza que o Pai aplica ao salvar (Student#cleasing): espaços
    // normalizados, e-mail minúsculo, CPF só com dígitos, crachá em caixa alta.
    const name = squish(dto.name);
    const nickName = squish(dto.nickName).toUpperCase();
    const email = dto.email.trim().toLowerCase();
    const phone = optional(dto.phone);
    const ownerName = optional(dto.ownerName);
    const ownerDocument = optional(dto.ownerDocument)?.replace(/\D/g, '') || undefined;
    const note = squish(dto.note);
    if (!note) {
      throw new BadRequestException('Informe a observação do cadastro.');
    }
    const token = randomUUID();

    return this.prisma.$transaction(async (tx: LocalTransactionClient) => {
      const student = await this.studentsService.createProvisional(tx, {
        courseId: dto.courseId,
        courseName: course.courseName,
        courseEventDate: course.courseEventDate,
        courseEventDateEnd: course.courseEventDateEnd,
        courseEventType: course.courseEventType,
        name,
        token,
        email,
        document,
      });

      const registration = await tx.studentRegistration.create({
        data: {
          token,
          courseId: dto.courseId,
          localStudentId: student.id,
          status: 'pending',
          name,
          nickName,
          document,
          email,
          phone: phone ?? null,
          ownerName: ownerName ?? null,
          ownerDocument: ownerDocument ?? null,
          note,
          sourceAgentKey: this.agentKey,
        },
      });

      const message: StudentCreateRequestedMessage = {
        eventId: registration.id,
        courseId: dto.courseId,
        token,
        name,
        nickName,
        document,
        email,
        phone,
        ownerName,
        ownerDocument,
        note,
        sourceAgentKey: this.agentKey,
        occurredAt: new Date().toISOString(),
      };

      await this.outboxService.record(tx, {
        aggregateType: 'student_registration',
        aggregateId: registration.id,
        eventType: 'student.create.requested',
        routingKey: STUDENT_CREATE_REQUESTED_ROUTING_KEY,
        payload: message,
      });

      this.logger.log(
        `Aluno cadastrado localmente — registro=${registration.id} id provisório=${student.id} turma=${dto.courseId}. Aguardando confirmação assíncrona do Checkin Pai.`,
      );

      return this.toStatus(registration, student.id);
    });
  }

  async getStatus(id: string): Promise<RegistrationStatus> {
    const registration = await this.prisma.studentRegistration.findUnique({ where: { id } });
    if (!registration) {
      throw new NotFoundException(`Cadastro ${id} não encontrado.`);
    }
    // Depois da confirmação o id do Student mudou: o token é quem liga os dois.
    const student = await this.studentsService.findByToken(registration.token);
    return this.toStatus(registration, student?.id ?? registration.localStudentId);
  }

  /**
   * Aplica o resultado (recebido via RabbitMQ) ao registro local. Só existe
   * um `StudentRegistration` com este `eventId` na estação que originou o
   * cadastro; nas demais é um no-op silencioso.
   */
  async applyResult(
    eventId: string,
    success: boolean,
    errorMessage?: string,
    paiStudentId?: number,
  ): Promise<void> {
    await this.prisma.studentRegistration.updateMany({
      where: { id: eventId, status: 'pending' },
      data: {
        status: success ? 'completed' : 'failed',
        errorMessage: errorMessage ?? null,
        paiStudentId: paiStudentId ?? null,
        resolvedAt: new Date(),
      },
    });
  }

  private toStatus(
    registration: {
      id: string;
      status: string;
      courseId: number;
      name: string;
      token: string;
      errorMessage: string | null;
      createdAt: Date;
      resolvedAt: Date | null;
    },
    studentId: number,
  ): RegistrationStatus {
    return {
      id: registration.id,
      status: registration.status,
      courseId: registration.courseId,
      studentName: registration.name,
      token: registration.token,
      studentId,
      errorMessage: registration.errorMessage,
      createdAt: registration.createdAt,
      resolvedAt: registration.resolvedAt,
    };
  }
}
