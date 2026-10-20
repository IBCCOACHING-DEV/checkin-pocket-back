import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PrintService } from '../print/print.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { PrintJobDeadLetterMessage } from '../messaging/types';
import { PRINT_JOBS_DLX_EXCHANGE, PRINT_JOB_FAILED_ROUTING_KEY } from '../messaging/rabbitmq.constants';
import { LocalPrintJobsService } from './local-print-jobs.service';
import { PrintJob } from '../../generated/prisma-local';

const WORKER_TICK_MS = 2000;
const BATCH_SIZE = 5;
const RETRY_BACKOFF_BASE_MS = 3000;

/**
 * Worker local que efetivamente imprime as etiquetas criadas em
 * `print_jobs`. Roda de forma assíncrona e desacoplada da requisição de
 * check-in — o endpoint de check-in só cria o registro `pending`.
 *
 * Tolerância a falhas: cada job tem `max_attempts`. Ao esgotar as
 * tentativas, o job é marcado `dead` e uma mensagem é publicada na
 * dead-letter exchange do RabbitMQ (`ibc.print.dlx`), evitando travar o
 * processamento dos próximos jobs pendentes.
 */
@Injectable()
export class LocalPrintWorkerService {
  private readonly logger = new Logger(LocalPrintWorkerService.name);
  private running = false;
  // Cada etiqueta leva ~2s pra imprimir (canvas+PDF+SumatraPDF) — bem perto
  // do próprio WORKER_TICK_MS. Sem isso, um triggerNow() que chega enquanto
  // um ciclo anterior ainda está processando era simplesmente descartado
  // (ver `running`), e o job ficava esperando até WORKER_TICK_MS inteiro
  // pelo próximo tick automático — dobrando a latência percebida entre o
  // check-in e a etiqueta sair. Com essa flag, o ciclo em andamento roda de
  // novo assim que termina, em vez de esperar o próximo @Interval.
  private rerunRequested = false;

  constructor(
    private readonly printJobsService: LocalPrintJobsService,
    private readonly printService: PrintService,
    private readonly rabbitMq: RabbitMqService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Dispara o processamento imediatamente, sem esperar o próximo tick do
   * @Interval — chamado pelo CheckinService assim que um print_job é
   * criado, pra não pagar a latência do polling (até WORKER_TICK_MS) no
   * caminho crítico do credenciamento. Fire-and-forget: nunca bloqueia
   * quem chama; erros já são tratados/logados dentro de runCycle.
   */
  triggerNow(): void {
    void this.runCycle();
  }

  @Interval(WORKER_TICK_MS)
  async handleTick(): Promise<void> {
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;

    try {
      do {
        this.rerunRequested = false;
        try {
          await this.processPendingJobs();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Falha no ciclo do worker de impressão local: ${message}`);
        }
      } while (this.rerunRequested);
    } finally {
      this.running = false;
    }
  }

  private async processPendingJobs(): Promise<void> {
    const candidates = await this.printJobsService.findPendingBatch(20);
    const now = Date.now();

    const dueJobs = candidates.filter((job) => {
      const backoffMs = job.attemptCount * RETRY_BACKOFF_BASE_MS;
      return now - job.updatedAt.getTime() >= backoffMs;
    });

    for (const job of dueJobs.slice(0, BATCH_SIZE)) {
      // Isola cada job: uma falha inesperada em um não deve impedir a
      // tentativa dos demais jobs pendentes deste ciclo.
      try {
        await this.processJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Falha inesperada ao processar print_job=${job.id}: ${message}`);
      }
    }
  }

  private async processJob(job: PrintJob): Promise<void> {
    this.logger.debug(`print_job=${job.id} — iniciando processamento. TS_PROCESS_START=${Date.now()}`);
    const startedAt = new Date();

    const result = await this.printService.printText({
      name: job.labelName,
      nickname: job.labelName,
      course: job.labelCourseName,
      token: job.labelToken ?? undefined,
      city: job.labelCity ?? undefined,
      printerName: job.targetPrinterUid,
      copies: 1,
      // Se a 1ª tentativa (attemptCount=0) já usou o caminho raw
      // (PRINT_USE_RAW_RASTER) e falhou, os retries seguintes forçam o
      // caminho comprovado (Sumatra) em vez de insistir no raw — evita que
      // um problema sistemático no raw derrube a etiqueta pra dead-letter
      // sem nunca tentar o caminho que sempre funcionou.
      forceSumatra: job.attemptCount > 0,
    });

    const finishedAt = new Date();

    await this.printJobsService.recordAttempt(job.id, {
      startedAt,
      finishedAt,
      success: result.success,
      errorCode: result.success ? undefined : 'PRINT_ERROR',
      errorMessage: result.success ? undefined : result.error,
    });

    if (result.success) {
      await this.printJobsService.markSucceeded(job.id, JSON.stringify(result));
      this.logger.log(`Etiqueta impressa com sucesso — print_job=${job.id}, aluno=${job.studentId}.`);
      return;
    }

    const attemptCount = job.attemptCount + 1;

    if (attemptCount >= job.maxAttempts) {
      await this.printJobsService.markDead(job.id, attemptCount, JSON.stringify(result));
      this.logger.error(
        `print_job=${job.id} esgotou ${attemptCount}/${job.maxAttempts} tentativas. Enviando para a DLQ de impressão.`,
      );
      await this.sendToDeadLetter(job, attemptCount, result.error);
      return;
    }

    await this.printJobsService.markRetry(job.id, attemptCount);
    this.logger.warn(
      `print_job=${job.id} falhou (tentativa ${attemptCount}/${job.maxAttempts}). Novo retry será agendado.`,
    );
  }

  private async sendToDeadLetter(job: PrintJob, attemptCount: number, lastError?: string): Promise<void> {
    const message: PrintJobDeadLetterMessage = {
      printJobId: job.id,
      studentId: job.studentId,
      targetPrinterUid: job.targetPrinterUid,
      attemptCount,
      maxAttempts: job.maxAttempts,
      lastError: lastError ?? null,
      sourceAgentKey: this.configService.get<string>('checkinAgent.agentKey', 'unknown-agent'),
      occurredAt: new Date().toISOString(),
    };

    const published = await this.rabbitMq.publish(
      PRINT_JOBS_DLX_EXCHANGE,
      PRINT_JOB_FAILED_ROUTING_KEY,
      message,
    );

    if (!published) {
      this.logger.error(
        `Não foi possível publicar o print_job=${job.id} na dead-letter exchange (broker indisponível).`,
      );
    }
  }
}
