import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StudentRegistrationService } from './student-registration.service';

describe('StudentRegistrationService — escopo de turmas do operador', () => {
  const dto = {
    courseId: 7,
    name: 'Maria',
    nickName: 'maria',
    document: '123.456.789-01',
    email: 'maria@x.com',
    note: 'cortesia',
  };

  function build(context: { courseEventType: string | null } | null) {
    const tx = {
      studentRegistration: { create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'r1', createdAt: new Date(), resolvedAt: null, errorMessage: null, ...args.data })) },
    };
    const prisma = { $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)) };
    const students = {
      findCourseContext: jest.fn(async () =>
        context && { courseName: 'T', courseEventDate: null, courseEventDateEnd: null, ...context },
      ),
      findByDocumentInCourse: jest.fn(async () => null),
      createProvisional: jest.fn(async () => ({ id: -1 })),
    };
    const outbox = { record: jest.fn() };
    const config = { get: jest.fn((_k: string, d: string) => d) };
    const service = new StudentRegistrationService(prisma as never, outbox as never, students as never, config as never);
    return { service, prisma, students };
  }

  it('recusa (403) cadastro em turma de formação para operador restrito a eventos', async () => {
    const { service, prisma } = build({ courseEventType: 'formation' });

    await expect(service.register(dto, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recusa cadastro em turma de tipo desconhecido para operador restrito', async () => {
    const { service } = build({ courseEventType: null });

    await expect(service.register(dto, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('permite cadastro em turma de evento e grava o tipo da turma no aluno provisório', async () => {
    const { service, students } = build({ courseEventType: 'event' });

    await service.register(dto, { eventType: 'event' });

    expect(students.createProvisional).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ courseEventType: 'event' }),
    );
  });

  it('turma não baixada continua devolvendo 404, antes de qualquer checagem de perfil', async () => {
    const { service } = build(null);

    await expect(service.register(dto, { eventType: 'event' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
