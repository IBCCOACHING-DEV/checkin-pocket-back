import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { Student } from '../../generated/prisma-local';
import { StudentsService } from '../students/students.service';
import { LocalPrintJobsService } from '../local-print/local-print-jobs.service';
import { LocalPrintWorkerService } from '../local-print/local-print-worker.service';
import { OutboxService } from '../outbox/outbox.service';
import { CHECKIN_PERFORMED_ROUTING_KEY } from '../messaging/rabbitmq.constants';
import { CheckinPerformedMessage } from '../messaging/types';
import { CourseScope, isCourseAllowed } from '../auth/course-scope';
import { CheckinRequestDto } from './dto/checkin-request.dto';
import { CheckinResult } from './interfaces/checkin-result.interface';
import { localIsoDate } from './local-date';

@Injectable()
export class CheckinService {
  private readonly logger = new Logger(CheckinService.name);

  constructor(
    private readonly prisma: LocalPrismaService,
    private readonly studentsService: StudentsService,
    private readonly printJobsService: LocalPrintJobsService,
    private readonly printWorker: LocalPrintWorkerService,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService,
  ) {}

  private get agentKey(): string {
    return this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent');
  }

  private get defaultPrinterUid(): string {
    return this.configService.get<string>('print.defaultPrinter', '');
  }

  async performCheckin(dto: CheckinRequestDto, scope?: CourseScope): Promise<CheckinResult> {
    const student = await this.studentsService.findByToken(dto.studentToken);

    if (!student) {
      this.logger.warn(`Check-in recusado — token não encontrado na base local (token=${dto.studentToken}).`);
      return {
        success: false,
        message: 'Aluno não encontrado na base local. Sincronize os ingressos antes do check-in.',
      };
    }
    if (!isCourseAllowed(scope, student.courseEventType)) {
      // Mesmo texto genérico de "não encontrado" no log do operador, sem revelar dados do aluno de outro perfil.
      this.logger.warn(
        `Check-in recusado — aluno=${student.id} está em turma fora do perfil do operador (tipo "${student.courseEventType ?? 'desconhecido'}").`,
      );
      return {
        success: false,
        message:
          'Este aluno pertence a uma turma fora do seu perfil de acesso. Se ele for do seu perfil, use "Atualizar turmas" e tente de novo.',
      };
    }
    if (dto.courseId !== undefined && student.courseId !== dto.courseId) {
      this.logger.warn(
        `Check-in recusado — aluno=${student.id} pertence à turma ${student.courseId}, mas a turma selecionada foi ${dto.courseId}.`,
      );
      return {
        success: false,
        message: 'Aluno não pertence à turma selecionada.',
      };
    }

    if (this.isCheckedInToday(student)) {
      this.logger.log(`Check-in ignorado — aluno=${student.id} (${student.name}) já credenciado hoje.`);
      return {
        success: true,
        alreadyCheckedIn: true,
        message: 'Aluno já credenciado hoje.',
        studentId: student.id,
        studentName: student.name,
        courseName: student.courseName,
      };
    }

    const windowError = this.validateCourseWindow(student);
    if (windowError) {
      this.logger.warn(`Check-in recusado — aluno=${student.id} (${student.name}): ${windowError}`);
      return {
        success: false,
        message: windowError,
        studentId: student.id,
        studentName: student.name,
        courseName: student.courseName,
      };
    }

    const checkedInAt = new Date();
    // A etiqueta só sai uma vez: nos demais dias do evento o check-in apenas
    // registra a presença (espelha `tag_printer` no Checkin Pai).
    const shouldPrint = !student.labelPrinted;
    const printerUid = dto.printerUid?.trim() || this.defaultPrinterUid;
    // Alunos criados aqui (cadastro manual) ou por outra estação nascem sem
    // cidade: herda a dos demais alunos da turma. Só consulta se for imprimir.
    const labelCity = shouldPrint
      ? (student.courseCity ?? (await this.studentsService.findCourseCity(student.courseId)))
      : null;

    const printJobId = await this.prisma.$transaction(async (tx: LocalTransactionClient) => {
      await this.studentsService.markCheckedIn(tx, student.id, checkedInAt, shouldPrint);

      let createdPrintJobId: number | undefined;
      if (shouldPrint) {
        const printJob = await this.printJobsService.createPendingJob(tx, {
          studentId: student.id,
          courseId: student.courseId,
          targetPrinterUid: printerUid,
          labelName: student.name,
          labelCourseName: student.courseName,
          labelToken: student.token,
          labelCity,
          idempotencyKey: `pocket-${this.agentKey}-${student.id}-${randomUUID()}`,
        });
        createdPrintJobId = printJob.id;
      }

      const message: CheckinPerformedMessage = {
        eventId: randomUUID(),
        studentId: student.id,
        courseId: student.courseId,
        studentName: student.name,
        courseName: student.courseName,
        studentToken: student.token,
        checkedInAt: checkedInAt.toISOString(),
        sourceAgentKey: this.agentKey,
        occurredAt: new Date().toISOString(),
        labelPrinted: shouldPrint,
      };

      await this.outboxService.record(tx, {
        aggregateType: 'student_checkin',
        aggregateId: String(student.id),
        eventType: 'student.checked_in',
        routingKey: CHECKIN_PERFORMED_ROUTING_KEY,
        payload: message,
      });

      return createdPrintJobId;
    });

    if (shouldPrint) {
      // Acorda o worker de impressão local imediatamente em vez de esperar o
      // próximo tick do polling (até 2s) — maior parte da latência entre
      // clicar em "Credenciar" e a etiqueta sair da impressora.
      this.printWorker.triggerNow();
    }

    this.logger.log(
      shouldPrint
        ? `Check-in realizado — aluno=${student.id} (${student.name}) turma="${student.courseName}" print_job=${printJobId}. TS_TRIGGER=${Date.now()}`
        : `Presença registrada — aluno=${student.id} (${student.name}) turma="${student.courseName}"; etiqueta já impressa antes, nada a imprimir.`,
    );

    return {
      success: true,
      message: shouldPrint
        ? 'Check-in realizado com sucesso.'
        : 'Presença registrada. A etiqueta já havia sido impressa — nenhuma nova etiqueta foi gerada.',
      studentId: student.id,
      studentName: student.name,
      courseName: student.courseName,
      labelPrinted: shouldPrint,
      printJobId,
    };
  }

  /**
   * `checkedInAt` é a presença mais recente: se cai no dia de hoje, o aluno já
   * foi credenciado hoje. Aluno marcado sem data (legado) conta como já presente.
   */
  private isCheckedInToday(student: Student): boolean {
    if (!student.checkedIn) {
      return false;
    }
    return !student.checkedInAt || localIsoDate(student.checkedInAt) === this.todayIsoDate();
  }

  private validateCourseWindow(student: Student): string | null {
    const { courseEventDate, courseEventDateEnd } = student;
    if (!courseEventDate && !courseEventDateEnd) {
      return null;
    }

    const today = this.todayIsoDate();

    if (courseEventDate && today < courseEventDate) {
      return `Fora do período da turma "${student.courseName}" — o credenciamento abre em ${this.formatBrDate(courseEventDate)}.`;
    }

    if (courseEventDateEnd && today > courseEventDateEnd) {
      return `Fora do período da turma "${student.courseName}" — o credenciamento encerrou em ${this.formatBrDate(courseEventDateEnd)}.`;
    }

    return null;
  }

  private todayIsoDate(): string {
    return localIsoDate();
  }

  private formatBrDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-');
    return `${day}/${month}/${year}`;
  }
}
