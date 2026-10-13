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

  describe('escopo de turmas do operador (espelha a CoursePolicy do Pai)', () => {
    it('recusa aluno de turma de formação para operador restrito a eventos', async () => {
      studentsService.findByToken.mockResolvedValue({ ...mockStudent, courseEventType: 'formation' });

      const result = await service.performCheckin({ studentToken: 'token-123' }, { eventType: 'event' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('fora do seu perfil');
      expect(result.studentName).toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('recusa aluno sem tipo de turma conhecido para operador restrito', async () => {
      studentsService.findByToken.mockResolvedValue({ ...mockStudent, courseEventType: null });

      const result = await service.performCheckin({ studentToken: 'token-123' }, { eventType: 'event' });

      expect(result.success).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('credencia aluno de evento para operador restrito a eventos', async () => {
      studentsService.findByToken.mockResolvedValue({ ...mockStudent, courseEventType: 'event' });
      printJobsService.createPendingJob.mockResolvedValue({ id: 1 });
      outboxService.record.mockResolvedValue({ id: 'o' });

      const result = await service.performCheckin({ studentToken: 'token-123' }, { eventType: 'event' });

      expect(result.success).toBe(true);
    });

    it('operador sem restrição credencia qualquer tipo, inclusive desconhecido', async () => {
      studentsService.findByToken.mockResolvedValue({ ...mockStudent, courseEventType: null });
      printJobsService.createPendingJob.mockResolvedValue({ id: 1 });
      outboxService.record.mockResolvedValue({ id: 'o' });

      const result = await service.performCheckin({ studentToken: 'token-123' }, { eventType: null });

      expect(result.success).toBe(true);
    });
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
      true,
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

  describe('etiqueta impressa uma única vez (eventos de vários dias)', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    it('no 1º check-in imprime a etiqueta e marca labelPrinted', async () => {
      studentsService.findByToken.mockResolvedValue({ ...mockStudent, labelPrinted: false });
      printJobsService.createPendingJob.mockResolvedValue({ id: 5 });

      const result = await service.performCheckin({ studentToken: 'token-123' });

      expect(result).toEqual(expect.objectContaining({ success: true, labelPrinted: true, printJobId: 5 }));
      expect(studentsService.markCheckedIn).toHaveBeenCalledWith(expect.anything(), 42, expect.any(Date), true);
      expect(printWorker.triggerNow).toHaveBeenCalledTimes(1);
      expect(outboxService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ payload: expect.objectContaining({ labelPrinted: true }) }),
      );
    });

    it('em outro dia, com etiqueta já impressa, registra só a presença (sem print_job)', async () => {
      studentsService.findByToken.mockResolvedValue({
        ...mockStudent,
        checkedIn: true,
        checkedInAt: yesterday,
        labelPrinted: true,
      });

      const result = await service.performCheckin({ studentToken: 'token-123' });

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBeUndefined();
      expect(result.labelPrinted).toBe(false);
      expect(result.printJobId).toBeUndefined();
      expect(studentsService.markCheckedIn).toHaveBeenCalledWith(expect.anything(), 42, expect.any(Date), false);
      expect(printJobsService.createPendingJob).not.toHaveBeenCalled();
      expect(printWorker.triggerNow).not.toHaveBeenCalled();
      // A presença continua indo para o Pai/outras estações.
      expect(outboxService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          routingKey: 'checkin.performed',
          payload: expect.objectContaining({ labelPrinted: false }),
        }),
      );
    });

    it('em outro dia, se a etiqueta NÃO foi impressa (job morreu), imprime de novo', async () => {
      studentsService.findByToken.mockResolvedValue({
        ...mockStudent,
        checkedIn: true,
        checkedInAt: yesterday,
        labelPrinted: false,
      });
      printJobsService.createPendingJob.mockResolvedValue({ id: 8 });

      const result = await service.performCheckin({ studentToken: 'token-123' });

      expect(result).toEqual(expect.objectContaining({ success: true, labelPrinted: true, printJobId: 8 }));
    });

    it('segunda leitura no MESMO dia continua idempotente (nem presença nem etiqueta)', async () => {
      studentsService.findByToken.mockResolvedValue({
        ...mockStudent,
        checkedIn: true,
        checkedInAt: new Date(),
        labelPrinted: true,
      });

      const result = await service.performCheckin({ studentToken: 'token-123' });

      expect(result.alreadyCheckedIn).toBe(true);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(outboxService.record).not.toHaveBeenCalled();
    });
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
