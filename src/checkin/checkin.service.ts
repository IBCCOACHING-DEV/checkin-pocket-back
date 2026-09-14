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
import { CheckinRequestDto } from './dto/checkin-request.dto';
import { CheckinResult } from './interfaces/checkin-result.interface';

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

  async performCheckin(dto: CheckinRequestDto): Promise<CheckinResult> {
    const student = await this.studentsService.findByToken(dto.studentToken);

    if (!student) {
      this.logger.warn(`Check-in recusado — token não encontrado na base local (token=${dto.studentToken}).`);
      return {
        success: false,
        message: 'Aluno não encontrado na base local. Sincronize os ingressos antes do check-in.',
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

    if (student.checkedIn) {
      this.logger.log(`Check-in ignorado — aluno=${student.id} (${student.name}) já credenciado anteriormente.`);
      return {
        success: true,
        alreadyCheckedIn: true,
        message: 'Aluno já credenciado anteriormente.',
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
    const printerUid = dto.printerUid?.trim() || this.defaultPrinterUid;
    const idempotencyKey = `pocket-${this.agentKey}-${student.id}-${randomUUID()}`;

    const printJobId = await this.prisma.$transaction(async (tx: LocalTransactionClient) => {
      await this.studentsService.markCheckedIn(tx, student.id, checkedInAt);

      const printJob = await this.printJobsService.createPendingJob(tx, {
        studentId: student.id,
        courseId: student.courseId,
        targetPrinterUid: printerUid,
        labelName: student.name,
        labelCourseName: student.courseName,
        idempotencyKey,
      });

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
      };

      await this.outboxService.record(tx, {
        aggregateType: 'student_checkin',
        aggregateId: String(student.id),
        eventType: 'student.checked_in',
        routingKey: CHECKIN_PERFORMED_ROUTING_KEY,
        payload: message,
      });

      return printJob.id;
    });

    // Acorda o worker de impressão local imediatamente em vez de esperar o
    // próximo tick do polling (até 2s) — maior parte da latência entre
    // clicar em "Credenciar" e a etiqueta sair da impressora.
    this.printWorker.triggerNow();

    this.logger.log(
      `Check-in realizado — aluno=${student.id} (${student.name}) turma="${student.courseName}" print_job=${printJobId}. TS_TRIGGER=${Date.now()}`,
    );

    return {
      success: true,
      message: 'Check-in realizado com sucesso.',
      studentId: student.id,
      studentName: student.name,
      courseName: student.courseName,
      printJobId,
    };
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
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatBrDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-');
    return `${day}/${month}/${year}`;
  }
}
