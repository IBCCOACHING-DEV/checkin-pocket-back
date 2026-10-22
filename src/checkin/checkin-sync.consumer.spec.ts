import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CheckinSyncConsumer } from './checkin-sync.consumer';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { StudentsService } from '../students/students.service';

describe('CheckinSyncConsumer', () => {
  let consumer: CheckinSyncConsumer;

  type Handler = (content: Buffer) => Promise<void>;
  let registeredHandler: Handler | null;
  let setupDone: Promise<void>;

  const rabbitMq = {
    // O serviço real roda o setup ao conectar e a cada reconexão; aqui, na hora.
    registerConsumer: jest.fn((_name: string, setup: () => Promise<void>) => {
      setupDone = setup();
    }),
    assertAndBindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_queue: string, handler: Handler) => {
      registeredHandler = handler;
      return Promise.resolve();
    }),
  };

  const studentsService = {
    applyRemoteCheckin: jest.fn(),
  };

  const configService = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback ?? 'agent-a'),
  };

  const validMessage = {
    eventId: 'evt-1',
    studentId: 42,
    courseId: 7,
    studentName: 'Fulano de Tal',
    courseName: 'Turma XPTO',
    studentToken: 'token-123',
    checkedInAt: '2026-08-21T12:00:00.000Z',
    sourceAgentKey: 'agent-b',
    occurredAt: '2026-08-21T12:00:01.000Z',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    registeredHandler = null;

    // Simula CHECKIN_AGENT_KEY = 'agent-a' para esta estação.
    configService.get.mockImplementation((key: string) =>
      key === 'checkinAgent.agentKey' ? 'agent-a' : undefined,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckinSyncConsumer,
        { provide: RabbitMqService, useValue: rabbitMq },
        { provide: StudentsService, useValue: studentsService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    consumer = module.get<CheckinSyncConsumer>(CheckinSyncConsumer);
    consumer.onModuleInit();
    await setupDone;
  });

  it('declara a fila own agent e registra o consumidor (remontável a cada reconexão)', () => {
    expect(rabbitMq.registerConsumer).toHaveBeenCalledWith('checkin.sync.agent-a', expect.any(Function));
    expect(rabbitMq.assertAndBindQueue).toHaveBeenCalledWith(
      'checkin.sync.agent-a.dlq',
      'ibc.checkin.events.dlx',
      'checkin.performed.dead',
      { arguments: { 'x-expires': 7 * 24 * 60 * 60 * 1000 } },
    );
    expect(rabbitMq.assertAndBindQueue).toHaveBeenCalledWith(
      'checkin.sync.agent-a',
      'ibc.checkin.events',
      'checkin.#',
      expect.objectContaining({
        arguments: expect.objectContaining({ 'x-expires': 7 * 24 * 60 * 60 * 1000 }),
      }),
    );
    expect(rabbitMq.consume).toHaveBeenCalledWith('checkin.sync.agent-a', expect.any(Function));
  });

  it('aplica o check-in remoto quando o evento vem de outra estação', async () => {
    expect(registeredHandler).not.toBeNull();

    await registeredHandler!(Buffer.from(JSON.stringify(validMessage)));

    expect(studentsService.applyRemoteCheckin).toHaveBeenCalledWith({
      id: 42,
      name: 'Fulano de Tal',
      courseId: 7,
      courseName: 'Turma XPTO',
      token: 'token-123',
      // Mensagem de estação antiga (sem o campo) = todo check-in imprimia.
      labelPrinted: true,
      checkedInAt: new Date('2026-08-21T12:00:00.000Z'),
    });
  });

  it('ignora o eco do próprio check-in (mesmo agentKey)', async () => {
    const ownEvent = { ...validMessage, sourceAgentKey: 'agent-a' };

    await registeredHandler!(Buffer.from(JSON.stringify(ownEvent)));

    expect(studentsService.applyRemoteCheckin).not.toHaveBeenCalled();
  });

  it('rejeita (para permitir nack/DLQ) quando o payload é inválido', async () => {
    const malformed = { ...validMessage, studentId: 'not-a-number' };

    await expect(registeredHandler!(Buffer.from(JSON.stringify(malformed)))).rejects.toThrow();
    expect(studentsService.applyRemoteCheckin).not.toHaveBeenCalled();
  });
});
