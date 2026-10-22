import { ForbiddenException } from '@nestjs/common';
import { TicketTransferService } from './ticket-transfer.service';

describe('TicketTransferService — escopo de turmas do operador', () => {
  function build(options: { remoteCourseType?: string | null; remoteFails?: boolean; localCourseType?: string | null } = {}) {
    const remote = {
      client: {
        student: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
        course: {
          findUnique: jest.fn(async () => {
            if (options.remoteFails) {
              throw new Error('Pai fora do ar');
            }
            return options.remoteCourseType === undefined ? null : { eventType: options.remoteCourseType };
          }),
        },
      },
    };
    const tx = {
      ticketTransfer: { create: jest.fn(async () => ({ id: 't1', status: 'pending', studentId: 1, courseId: 7, errorMessage: null, createdAt: new Date(), resolvedAt: null })) },
    };
    const prisma = { $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)) };
    const students = {
      applyLocalTransfer: jest.fn(async () => true),
      findCheckinStates: jest.fn(
        async (): Promise<Map<number, { checkedIn: boolean; checkedInAt: Date | null }>> => new Map(),
      ),
      findCourseContext: jest.fn(async () =>
        options.localCourseType === undefined ? null : { courseEventType: options.localCourseType },
      ),
    };
    const outbox = { record: jest.fn() };
    const config = { get: jest.fn((_k: string, d: string) => d) };
    const service = new TicketTransferService(prisma as never, remote as never, outbox as never, students as never, config as never);
    return { service, remote, prisma, students };
  }

  const dto = { studentId: 1, courseId: 7, name: 'N', email: 'a@b.com', phone: '1' };

  describe('search', () => {
    it('operador restrito a eventos só busca ingressos de turmas ativas do tipo evento', async () => {
      const { service, remote } = build();

      await service.search('123.456.789-01', { eventType: 'event' });

      expect(remote.client.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ document: '12345678901' }, { document: '123.456.789-01' }],
            course: { is: { status: true, eventType: 'event' } },
          },
        }),
      );
    });

    it('operador sem restrição busca em todas as turmas ativas', async () => {
      const { service, remote } = build();

      await service.search('12345678901', { eventType: null });

      expect(remote.client.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ course: { is: { status: true } } }),
        }),
      );
    });

    describe('credenciamento do titular atual', () => {
      const paiCheckin = new Date('2026-10-22T13:00:00Z');
      const localCheckin = new Date('2026-10-22T15:00:00Z');
      const row = (id: number, checkinDate: Date | null = null) => ({
        id,
        courseId: 7,
        name: `Aluno ${id}`,
        email: null,
        document: '123',
        checkinDate,
        course: { name: 'Turma' },
      });

      it('marca como credenciado quando o Pai tem a presença (checkin_date)', async () => {
        const { service, remote } = build();
        remote.client.student.findMany.mockResolvedValue([row(1, paiCheckin), row(2)] as never);

        const [first, second] = await service.search('aluno');

        expect(first).toMatchObject({ checkedIn: true, checkedInAt: paiCheckin });
        expect(second).toMatchObject({ checkedIn: false, checkedInAt: null });
      });

      it('marca como credenciado quando só esta estação registrou (Pai ainda não recebeu)', async () => {
        const { service, remote, students } = build();
        remote.client.student.findMany.mockResolvedValue([row(1)] as never);
        students.findCheckinStates.mockResolvedValue(
          new Map([[1, { checkedIn: true, checkedInAt: localCheckin }]]),
        );

        const [result] = await service.search('aluno');

        expect(result).toMatchObject({ checkedIn: true, checkedInAt: localCheckin });
      });

      it('com as duas fontes, usa a presença mais recente', async () => {
        const { service, remote, students } = build();
        remote.client.student.findMany.mockResolvedValue([row(1, paiCheckin)] as never);
        students.findCheckinStates.mockResolvedValue(
          new Map([[1, { checkedIn: true, checkedInAt: localCheckin }]]),
        );

        const [result] = await service.search('aluno');

        expect(result.checkedInAt).toEqual(localCheckin);
      });
    });
  });

  describe('requestTransfer', () => {
    it('recusa (403) transferência de turma de formação para operador restrito a eventos', async () => {
      const { service, prisma } = build({ remoteCourseType: 'formation' });

      await expect(service.requestTransfer(dto, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('permite transferência de turma de evento para operador restrito a eventos', async () => {
      const { service, prisma } = build({ remoteCourseType: 'event' });

      await service.requestTransfer(dto, { eventType: 'event' });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('com o Pai inalcançável, confere o tipo guardado na réplica local', async () => {
      const denied = build({ remoteFails: true, localCourseType: 'formation' });
      await expect(denied.service.requestTransfer(dto, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);

      const allowed = build({ remoteFails: true, localCourseType: 'event' });
      await allowed.service.requestTransfer(dto, { eventType: 'event' });
      expect(allowed.prisma.$transaction).toHaveBeenCalled();
    });

    it('operador restrito com tipo da turma desconhecido em ambos os lugares é barrado', async () => {
      const { service } = build({ remoteFails: true });

      await expect(service.requestTransfer(dto, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('operador sem restrição nem consulta o tipo da turma', async () => {
      const { service, remote } = build();

      await service.requestTransfer(dto, { eventType: null });

      expect(remote.client.course.findUnique).not.toHaveBeenCalled();
    });
  });
});
