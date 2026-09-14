import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CheckinService } from './checkin.service';
import { LocalPrismaService } from '../database/local-prisma.service';
import { StudentsService } from '../students/students.service';
import { LocalPrintJobsService } from '../local-print/local-print-jobs.service';
import { LocalPrintWorkerService } from '../local-print/local-print-worker.service';
import { OutboxService } from '../outbox/outbox.service';

describe('CheckinService', () => {
  let service: CheckinService;

  const mockStudent = {
    id: 42,
    courseId: 7,
    courseName: 'Turma XPTO',
    name: 'Fulano de Tal',
    token: 'token-123',
    ibcCustomerId: null,
    checkedIn: false,
    checkedInAt: null,
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  const studentsService = {
    findByToken: jest.fn(),
    markCheckedIn: jest.fn(),
  };

  const printJobsService = {
    createPendingJob: jest.fn(),
  };

  const outboxService = {
    record: jest.fn(),
  };

  const printWorker = {
    triggerNow: jest.fn(),
  };

  const prisma = {
    $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback({})),
  };

  const configService = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckinService,
        { provide: LocalPrismaService, useValue: prisma },
        { provide: StudentsService, useValue: studentsService },
        { provide: LocalPrintJobsService, useValue: printJobsService },
        { provide: LocalPrintWorkerService, useValue: printWorker },
        { provide: OutboxService, useValue: outboxService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<CheckinService>(CheckinService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('retorna erro amigável quando o aluno não está na réplica local', async () => {
    studentsService.findByToken.mockResolvedValue(null);

    const result = await service.performCheckin({ studentToken: 'inexistente' });

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('é idempotente quando o aluno já está credenciado (não duplica job nem evento)', async () => {
    studentsService.findByToken.mockResolvedValue({ ...mockStudent, checkedIn: true });

    const result = await service.performCheckin({ studentToken: 'token-123' });

    expect(result.success).toBe(true);
    expect(result.alreadyCheckedIn).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(printJobsService.createPendingJob).not.toHaveBeenCalled();
    expect(outboxService.record).not.toHaveBeenCalled();
  });

  it('marca presença, cria o print_job e grava o outbox_event em uma única transação', async () => {
    studentsService.findByToken.mockResolvedValue(mockStudent);
    printJobsService.createPendingJob.mockResolvedValue({ id: 99 });
    outboxService.record.mockResolvedValue({ id: 'outbox-1' });

    const result = await service.performCheckin({
      studentToken: 'token-123',
      printerUid: 'HP-1',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        studentId: 42,
        studentName: 'Fulano de Tal',
        courseName: 'Turma XPTO',
        printJobId: 99,
      }),
    );

    expect(studentsService.markCheckedIn).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.any(Date),
    );

    expect(printJobsService.createPendingJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        studentId: 42,
        courseId: 7,
        targetPrinterUid: 'HP-1',
        labelName: 'Fulano de Tal',
        labelCourseName: 'Turma XPTO',
      }),
    );

    expect(outboxService.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateType: 'student_checkin',
        aggregateId: '42',
        eventType: 'student.checked_in',
        routingKey: 'checkin.performed',
      }),
    );

    expect(printWorker.triggerNow).toHaveBeenCalledTimes(1);
  });

  function isoDateOffsetFromToday(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  it('bloqueia o check-in antes do início da turma', async () => {
    studentsService.findByToken.mockResolvedValue({
      ...mockStudent,
      courseEventDate: isoDateOffsetFromToday(1),
      courseEventDateEnd: isoDateOffsetFromToday(3),
    });

    const result = await service.performCheckin({ studentToken: 'token-123' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Turma XPTO');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('bloqueia o check-in depois do fim da turma', async () => {
    studentsService.findByToken.mockResolvedValue({
      ...mockStudent,
      courseEventDate: isoDateOffsetFromToday(-3),
      courseEventDateEnd: isoDateOffsetFromToday(-1),
    });

    const result = await service.performCheckin({ studentToken: 'token-123' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Turma XPTO');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('permite o check-in dentro do período da turma', async () => {
    studentsService.findByToken.mockResolvedValue({
      ...mockStudent,
      courseEventDate: isoDateOffsetFromToday(-1),
      courseEventDateEnd: isoDateOffsetFromToday(1),
    });
    printJobsService.createPendingJob.mockResolvedValue({ id: 100 });
    outboxService.record.mockResolvedValue({ id: 'outbox-2' });

    const result = await service.performCheckin({ studentToken: 'token-123' });

    expect(result.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
