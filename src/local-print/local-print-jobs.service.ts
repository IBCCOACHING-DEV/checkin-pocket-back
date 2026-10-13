import { Injectable } from '@nestjs/common';
import { LocalPrismaService } from '../database/local-prisma.service';
import { LocalTransactionClient } from '../database/local-prisma.types';
import { PrintJob } from '../../generated/prisma-local';

export interface CreatePrintJobParams {
  studentId: number;
  courseId: number;
  targetPrinterUid: string;
  labelName: string;
  labelCourseName: string;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface RecordAttemptParams {
  startedAt: Date;
  finishedAt: Date;
  success: boolean;
  printerAgentId?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Acesso à tabela local `print_jobs` (etiqueta de credenciamento) e ao seu
 * histórico `print_job_attempts`.
 */
@Injectable()
export class LocalPrintJobsService {
  constructor(private readonly prisma: LocalPrismaService) {}

  /**
   * Cria o print_job em status `pending`. Deve ser chamado dentro da mesma
   * transação do check-in (studentId + outbox_event), conforme o critério
   * de aceite "imediatamente após o check-in, crie um registro em
   * print_jobs".
   */
  createPendingJob(tx: LocalTransactionClient, params: CreatePrintJobParams): Promise<PrintJob> {
    return tx.printJob.create({
      data: {
        studentId: params.studentId,
        courseId: params.courseId,
        targetPrinterUid: params.targetPrinterUid,
        labelName: params.labelName,
        labelCourseName: params.labelCourseName,
        mode: 'local',
        status: 'pending',
        maxAttempts: params.maxAttempts ?? 3,
        idempotencyKey: params.idempotencyKey,
      },
    });
  }

  findPendingBatch(limit: number): Promise<PrintJob[]> {
    return this.prisma.printJob.findMany({
      where: { status: 'pending' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  recordAttempt(printJobId: number, params: RecordAttemptParams): Promise<unknown> {
    return this.prisma.printJobAttempt.create({
      data: {
        printJobId,
        printerAgentId: params.printerAgentId,
        startedAt: params.startedAt,
        finishedAt: params.finishedAt,
        success: params.success,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
      },
    });
  }

  markSucceeded(printJobId: number, resultJson: string): Promise<PrintJob> {
    return this.prisma.printJob.update({
      where: { id: printJobId },
      data: { status: 'succeeded', resultJson },
    });
  }

  markRetry(printJobId: number, attemptCount: number): Promise<PrintJob> {
    return this.prisma.printJob.update({
      where: { id: printJobId },
      data: { status: 'pending', attemptCount },
    });
  }

  /**
   * Marca o job como `dead` e devolve a etiqueta do aluno ao estado "não
   * impressa": sem isso o aluno nunca mais teria etiqueta, já que o check-in
   * dos próximos dias só registra presença quando `labelPrinted` é true.
   */
  async markDead(printJobId: number, attemptCount: number, resultJson: string): Promise<PrintJob> {
    const job = await this.prisma.printJob.update({
      where: { id: printJobId },
      data: { status: 'dead', attemptCount, resultJson },
    });
    if (job.studentId !== null) {
      await this.prisma.student.updateMany({
        where: { id: job.studentId },
        data: { labelPrinted: false },
      });
    }
    return job;
  }
}
