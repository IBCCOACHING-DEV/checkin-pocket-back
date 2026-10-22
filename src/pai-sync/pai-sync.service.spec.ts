import { ForbiddenException } from '@nestjs/common';
import { PaiSyncService } from './pai-sync.service';

describe('PaiSyncService — escopo de turmas do operador', () => {
  function build(overrides: { course?: unknown; allowedIds?: number[] } = {}) {
    const course = {
      findMany: jest.fn(async (args: { select?: unknown }) =>
        args.select ? (overrides.allowedIds ?? []).map((id) => ({ id })) : [],
      ),
      findUnique: jest.fn(async () => overrides.course ?? null),
    };
    const remotePrisma = {
      client: { course, student: { findMany: jest.fn(async () => []) } },
      ping: jest.fn(async () => true),
      findEventCity: jest.fn(async (): Promise<string | null> => 'Goiânia - GO'),
    };
    const studentsService = {
      replaceCourse: jest.fn(async () => ({ synced: 0, removed: 0 })),
      listSyncedCourses: jest.fn(async () => [
        { courseId: 1, courseName: 'Evento', studentsCount: 1, lastSyncedAt: new Date() },
        { courseId: 2, courseName: 'Formação', studentsCount: 1, lastSyncedAt: new Date() },
      ]),
    };
    const service = new PaiSyncService(remotePrisma as never, studentsService as never);
    return { service, course, studentsService, remotePrisma };
  }

  describe('listActiveCourses', () => {
    it('operador restrito a eventos só lista turmas ativas do tipo evento', async () => {
      const { service, course } = build();

      await service.listActiveCourses({ eventType: 'event' });

      expect(course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: true, eventType: 'event' } }),
      );
    });

    it('operador sem restrição lista todas as turmas ativas', async () => {
      const { service, course } = build();

      await service.listActiveCourses({ eventType: null });

      expect(course.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: true } }));
    });
  });

  describe('syncCourse', () => {
    it('recusa (403) turma de formação para operador restrito a eventos, sem baixar nada', async () => {
      const { service, studentsService } = build({ course: { id: 2, name: 'F', eventType: 'formation' } });

      await expect(service.syncCourse(2, { eventType: 'event' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(studentsService.replaceCourse).not.toHaveBeenCalled();
    });

    it('baixa turma de evento para operador restrito a eventos e grava o tipo na réplica', async () => {
      const { service, studentsService } = build({ course: { id: 1, name: 'E', eventType: 'event' } });

      await service.syncCourse(1, { eventType: 'event' });

      expect(studentsService.replaceCourse).toHaveBeenCalledWith(1, []);
    });

    it('grava a cidade do evento (lida pelo online_reference) em cada aluno da réplica', async () => {
      const { service, studentsService, remotePrisma } = build({
        course: { id: 1, name: 'E', eventType: 'event', onlineReference: 11229 },
      });
      remotePrisma.client.student.findMany.mockResolvedValue([
        { id: 10, name: 'Ana', token: 'tok-1' },
      ] as never);

      await service.syncCourse(1);

      expect(remotePrisma.findEventCity).toHaveBeenCalledWith(11229);
      expect(studentsService.replaceCourse).toHaveBeenCalledWith(1, [
        expect.objectContaining({ id: 10, courseCity: 'Goiânia - GO' }),
      ]);
    });

    it('se a cidade não puder ser lida, baixa a turma mesmo assim (sem courseCity)', async () => {
      const { service, studentsService, remotePrisma } = build({
        course: { id: 1, name: 'E', eventType: 'event', onlineReference: 11229 },
      });
      remotePrisma.findEventCity.mockResolvedValue(null);
      remotePrisma.client.student.findMany.mockResolvedValue([
        { id: 10, name: 'Ana', token: 'tok-1' },
      ] as never);

      await service.syncCourse(1);

      expect(studentsService.replaceCourse).toHaveBeenCalledWith(1, [
        expect.objectContaining({ id: 10, courseCity: undefined }),
      ]);
    });

    it('sem escopo (download do login) baixa qualquer tipo', async () => {
      const { service, studentsService } = build({ course: { id: 2, name: 'F', eventType: 'formation' } });

      await service.syncCourse(2);

      expect(studentsService.replaceCourse).toHaveBeenCalled();
    });
  });

  describe('syncActiveCourses (sync do login)', () => {
    function buildLogin(activeIds: number[]) {
      const ctx = build({ course: { id: 1, name: 'E', eventType: 'event' } });
      ctx.course.findMany.mockResolvedValue(
        activeIds.map((id) => ({ id, name: `T${id}`, _count: { students: 0 } })) as never,
      );
      const syncCourseVisibility = jest.fn(async () => ({ hiddenCourses: 2, hiddenStudents: 40 }));
      Object.assign(ctx.studentsService, { syncCourseVisibility });
      return { ...ctx, syncCourseVisibility };
    }

    it('oculta na estação as turmas fora da lista de ativas e informa o total ocultado', async () => {
      const { service, syncCourseVisibility } = buildLogin([1, 3]);

      const summary = await service.syncActiveCourses();

      expect(syncCourseVisibility).toHaveBeenCalledWith([1, 3]);
      expect(summary).toMatchObject({ total: 2, hiddenCourses: 2, hiddenStudents: 40, error: null });
    });

    it('turma ativa que falhou no download continua na lista de ativas (segue visível)', async () => {
      const { service, course, syncCourseVisibility } = buildLogin([1, 3]);
      course.findUnique.mockResolvedValue(null); // download das duas falha: turma "não encontrada"

      const summary = await service.syncActiveCourses();

      expect(summary).toMatchObject({ synced: 0, failed: 2 });
      expect(syncCourseVisibility).toHaveBeenCalledWith([1, 3]);
    });

    it('Pai inacessível: não oculta nada', async () => {
      const { service, course, syncCourseVisibility } = buildLogin([1]);
      course.findMany.mockRejectedValue(new Error('timeout'));

      const summary = await service.syncActiveCourses();

      expect(summary.error).not.toBeNull();
      expect(syncCourseVisibility).not.toHaveBeenCalled();
    });

    it('falha ao ocultar não derruba o sync', async () => {
      const { service, syncCourseVisibility } = buildLogin([1]);
      syncCourseVisibility.mockRejectedValue(new Error('disco cheio'));

      const summary = await service.syncActiveCourses();

      expect(summary).toMatchObject({ error: null, hiddenCourses: 0, hiddenStudents: 0 });
    });
  });

  describe('syncAllKnownCourses', () => {
    it('operador restrito só re-sincroniza as turmas conhecidas que o Pai confirma serem do seu tipo', async () => {
      const { service, studentsService } = build({
        allowedIds: [1],
        course: { id: 1, name: 'E', eventType: 'event' },
      });

      const results = await service.syncAllKnownCourses({ eventType: 'event' });

      expect(results).toHaveLength(1);
      expect(studentsService.replaceCourse).toHaveBeenCalledTimes(1);
      expect(studentsService.replaceCourse).toHaveBeenCalledWith(1, []);
    });
  });
});
