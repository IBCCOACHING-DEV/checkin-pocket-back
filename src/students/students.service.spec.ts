import { StudentsService } from './students.service';
import { StudentReplicaDto } from './dto/upsert-students.dto';

function replica(id: number, courseId = 939): StudentReplicaDto {
  const dto = new StudentReplicaDto();
  dto.id = id;
  dto.courseId = courseId;
  dto.courseName = 'Turma';
  dto.name = `Aluno ${id}`;
  dto.token = `token-${id}`;
  return dto;
}

describe('StudentsService#syncCourseVisibility', () => {
  function build(stale: Array<{ courseId: number; courseName: string }>, hiddenCount: number) {
    const student = {
      findMany: jest.fn(async () => stale),
      updateMany: jest.fn(async (args: { data: { courseActive: boolean } }) => ({
        count: args.data.courseActive ? 0 : hiddenCount,
      })),
      deleteMany: jest.fn(),
    };
    const prisma = { $transaction: jest.fn(async (fn: (c: { student: typeof student }) => unknown) => fn({ student })) };
    return { service: new StudentsService(prisma as never), student };
  }

  it('oculta (sem apagar) as turmas fora da lista de ativas e reativa as que voltaram', async () => {
    const { service, student } = build(
      [
        { courseId: 7, courseName: 'Antiga A' },
        { courseId: 8, courseName: 'Antiga B' },
      ],
      120,
    );

    const result = await service.syncCourseVisibility([1, 2]);

    expect(result).toEqual({ hiddenCourses: 2, hiddenStudents: 120 });
    expect(student.updateMany).toHaveBeenCalledWith({
      where: { courseId: { in: [1, 2] }, courseActive: false },
      data: { courseActive: true },
    });
    expect(student.updateMany).toHaveBeenCalledWith({
      where: { courseId: { notIn: [1, 2] }, courseActive: true },
      data: { courseActive: false },
    });
    expect(student.deleteMany).not.toHaveBeenCalled();
  });

  it('sem turma inativa visível na estação não oculta nada', async () => {
    const { service, student } = build([], 0);

    const result = await service.syncCourseVisibility([1, 2]);

    expect(result).toEqual({ hiddenCourses: 0, hiddenStudents: 0 });
    expect(student.updateMany).toHaveBeenCalledTimes(1); // só a reativação
  });
});

describe('StudentsService#replaceCourse', () => {
  function build(removedCount: number, provisionals: Array<{ token: string }> = []) {
    const calls: string[] = [];
    const tx = {
      student: {
        findMany: jest.fn(async () => provisionals),
        findUnique: jest.fn(async ({ where }: { where: { token?: string; id?: number } }) => {
          if (where.token) {
            const id = provisionals.findIndex((p) => p.token === where.token);
            return id === -1 ? null : { id: -(id + 1), token: where.token };
          }
          return null;
        }),
        update: jest.fn(async () => {
          calls.push('promote');
        }),
        delete: jest.fn(async () => {
          calls.push('deleteProvisional');
        }),
        deleteMany: jest.fn(async () => {
          calls.push('deleteMany');
          return { count: removedCount };
        }),
        upsert: jest.fn(async () => {
          calls.push('upsert');
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new StudentsService(prisma as never);
    return { service, tx, prisma, calls };
  }

  it('remove da turma os alunos que não vieram do Pai, só dessa turma', async () => {
    const { service, tx } = build(77);

    const result = await service.replaceCourse(939, [replica(1), replica(2)]);

    expect(result).toEqual({ synced: 2, removed: 77 });
    expect(tx.student.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 939, id: { notIn: [1, 2], gte: 0 } },
    });
    expect(tx.student.upsert).toHaveBeenCalledTimes(2);
  });

  it('apaga ANTES de gravar (token reaproveitado não pode colidir com o registro antigo)', async () => {
    const { service, calls } = build(1);

    await service.replaceCourse(939, [replica(1)]);

    expect(calls).toEqual(['deleteMany', 'upsert']);
  });

  it('turma esvaziada no Pai esvazia a réplica local da turma', async () => {
    const { service, tx } = build(5);

    const result = await service.replaceCourse(939, []);

    expect(result).toEqual({ synced: 0, removed: 5 });
    expect(tx.student.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 939, id: { notIn: [], gte: 0 } },
    });
    expect(tx.student.upsert).not.toHaveBeenCalled();
  });

  it('roda tudo em uma única transação com timeout folgado para turmas grandes', async () => {
    const { service, prisma } = build(0);

    await service.replaceCourse(939, [replica(1)]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 120000 }));
  });
});

describe('StudentsService#replaceCourse — alunos cadastrados nesta estação (id provisório)', () => {
  function buildWithProvisional() {
    const tx = {
      student: {
        findMany: jest.fn(async () => [{ token: 'token-1' }]),
        findUnique: jest.fn(async ({ where }: { where: { token?: string; id?: number } }) =>
          where.token === 'token-1' ? { id: -1, token: 'token-1' } : null,
        ),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        upsert: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new StudentsService(prisma as never), tx };
  }

  it('promove o provisório ao id do Pai quando o download já traz o mesmo token', async () => {
    const { service, tx } = buildWithProvisional();

    await service.replaceCourse(939, [replica(1)]);

    expect(tx.student.update).toHaveBeenCalledWith({ where: { id: -1 }, data: { id: 1 } });
  });

  it('nunca apaga provisórios que o Pai ainda não conhece', async () => {
    const { service, tx } = buildWithProvisional();

    await service.replaceCourse(939, [replica(2)]);

    expect(tx.student.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 939, id: { notIn: [2], gte: 0 } },
    });
    expect(tx.student.update).not.toHaveBeenCalled();
  });
});

describe('StudentsService — cadastro manual de aluno', () => {
  it('createProvisional usa o próximo id negativo livre', async () => {
    const tx = {
      student: {
        aggregate: jest.fn(async () => ({ _min: { id: -3 } })),
        create: jest.fn(async ({ data }: { data: unknown }) => data),
      },
    };
    const service = new StudentsService({} as never);

    await service.createProvisional(tx as never, {
      courseId: 939,
      courseName: 'Turma',
      courseEventDate: null,
      courseEventDateEnd: null,
      courseEventType: 'event',
      name: 'Fulano',
      token: 'tok',
      email: 'a@b.com',
      document: '12345678901',
    });

    expect(tx.student.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: -4 }) });
  });

  it('createProvisional começa em -1 quando só há ids reais', async () => {
    const tx = {
      student: {
        aggregate: jest.fn(async () => ({ _min: { id: 150 } })),
        create: jest.fn(async ({ data }: { data: unknown }) => data),
      },
    };
    const service = new StudentsService({} as never);

    await service.createProvisional(tx as never, {
      courseId: 1,
      courseName: 'T',
      courseEventDate: null,
      courseEventDateEnd: null,
      courseEventType: null,
      name: 'N',
      token: 't',
      email: 'e@e.com',
      document: '1',
    });

    expect(tx.student.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: -1 }) });
  });

  describe('applyRemoteCheckin', () => {
    const checkedInAt = new Date('2026-10-08T12:00:00Z');

    it('check-in com id provisório de outra estação é aplicado pelo TOKEN, não pelo id', async () => {
      const prisma = {
        student: {
          findUnique: jest.fn(async ({ where }: { where: { token?: string; id?: number } }) =>
            where.token === 'tok' ? { id: 77, token: 'tok', checkedIn: false, checkedInAt: null } : { id: -3 },
          ),
          update: jest.fn(),
          create: jest.fn(),
        },
      };
      const service = new StudentsService(prisma as never);

      await service.applyRemoteCheckin({ id: -3, name: 'N', courseId: 1, courseName: 'T', token: 'tok', checkedInAt });

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 77 },
        data: { checkedIn: true, checkedInAt },
      });
      expect(prisma.student.create).not.toHaveBeenCalled();
    });

    function buildExisting(existing: Record<string, unknown>) {
      const prisma = {
        student: {
          findUnique: jest.fn(async ({ where }: { where: { token?: string; id?: number } }) =>
            where.id === 10 ? existing : null,
          ),
          update: jest.fn(),
          create: jest.fn(),
        },
      };
      return { prisma, service: new StudentsService(prisma as never) };
    }
    const payload10 = { id: 10, name: 'N', courseId: 1, courseName: 'T', token: 'tok', checkedInAt };

    it('presença de um dia seguinte (mais nova) avança checkedInAt', async () => {
      const { prisma, service } = buildExisting({
        id: 10,
        checkedIn: true,
        checkedInAt: new Date('2026-10-07T12:00:00Z'),
        labelPrinted: true,
      });

      await service.applyRemoteCheckin({ ...payload10, labelPrinted: false });

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { checkedIn: true, checkedInAt },
      });
    });

    it('evento mais antigo ou repetido não regride a presença', async () => {
      const { prisma, service } = buildExisting({ id: 10, checkedIn: true, checkedInAt, labelPrinted: true });

      await service.applyRemoteCheckin({ ...payload10, checkedInAt: new Date('2026-10-07T12:00:00Z') });
      await service.applyRemoteCheckin({ ...payload10 });

      expect(prisma.student.update).not.toHaveBeenCalled();
    });

    it('aprende que a etiqueta já foi impressa em outra estação', async () => {
      const { prisma, service } = buildExisting({ id: 10, checkedIn: false, checkedInAt: null, labelPrinted: false });

      await service.applyRemoteCheckin({ ...payload10, labelPrinted: true });

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { checkedIn: true, checkedInAt, labelPrinted: true },
      });
    });

    it('evento sem impressão (dia seguinte) não apaga labelPrinted', async () => {
      const { prisma, service } = buildExisting({
        id: 10,
        checkedIn: true,
        checkedInAt: new Date('2026-10-07T12:00:00Z'),
        labelPrinted: true,
      });

      await service.applyRemoteCheckin({ ...payload10, labelPrinted: false });

      const data = prisma.student.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('labelPrinted');
    });

    it('id provisório sem aluno local com esse token é ignorado (não cria registro com id negativo)', async () => {
      const prisma = {
        student: { findUnique: jest.fn(async () => null), update: jest.fn(), create: jest.fn() },
      };
      const service = new StudentsService(prisma as never);

      await service.applyRemoteCheckin({ id: -3, name: 'N', courseId: 1, courseName: 'T', token: 'tok', checkedInAt });

      expect(prisma.student.create).not.toHaveBeenCalled();
      expect(prisma.student.update).not.toHaveBeenCalled();
    });
  });

  describe('applyRemoteStudentCreated', () => {
    const payload = {
      id: 500,
      courseId: 939,
      courseName: 'Turma',
      name: 'Fulano',
      token: 'tok',
      email: 'a@b.com',
      document: '12345678901',
      ibcCustomerId: null,
    };

    function build(existingByToken: { id: number; token: string } | null) {
      const tx = {
        student: {
          findUnique: jest.fn(async ({ where }: { where: { token?: string; id?: number } }) =>
            where.token ? existingByToken : null,
          ),
          update: jest.fn(),
          delete: jest.fn(),
          upsert: jest.fn(),
        },
      };
      const prisma = {
        $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
        // Turma que a estação já conhece (herança de visibilidade); null = turma desconhecida.
        student: { findFirst: jest.fn(async (): Promise<{ courseActive: boolean } | null> => null) },
      };
      return { service: new StudentsService(prisma as never), tx, prisma };
    }

    it('aluno criado por evento herda a visibilidade da turma que a estação já conhece (oculta continua oculta)', async () => {
      const { service, tx, prisma } = build(null);
      prisma.student.findFirst.mockResolvedValue({ courseActive: false });

      await service.applyRemoteStudentCreated(payload);

      expect(tx.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ courseActive: false }) }),
      );
    });

    it('turma desconhecida na estação: o aluno criado por evento entra como ativo', async () => {
      const { service, tx } = build(null);

      await service.applyRemoteStudentCreated(payload);

      expect(tx.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ courseActive: true }) }),
      );
    });

    it('estação de origem: troca o id provisório pelo definitivo, preservando o registro', async () => {
      const { service, tx } = build({ id: -2, token: 'tok' });

      await service.applyRemoteStudentCreated(payload);

      expect(tx.student.update).toHaveBeenCalledWith({ where: { id: -2 }, data: { id: 500 } });
    });

    it('outra estação: cria o aluno com o id do Pai', async () => {
      const { service, tx } = build(null);

      await service.applyRemoteStudentCreated(payload);

      expect(tx.student.update).not.toHaveBeenCalled();
      expect(tx.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 500 }, create: expect.objectContaining({ id: 500, token: 'tok' }) }),
      );
    });

    it('token já existe com outro id real: não tenta criar (evita violar o índice único)', async () => {
      const { service, tx } = build({ id: 42, token: 'tok' });

      await service.applyRemoteStudentCreated(payload);

      expect(tx.student.upsert).not.toHaveBeenCalled();
    });
  });
});

describe('StudentsService — escopo de turmas do operador', () => {
  function build() {
    const prisma = { student: { findMany: jest.fn(async () => []) } };
    return { service: new StudentsService(prisma as never), prisma };
  }

  it('search: operador restrito a eventos só consulta alunos de turmas de evento', async () => {
    const { service, prisma } = build();

    await service.search('maria', { eventType: 'event' });

    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ courseEventType: 'event' }) }),
    );
  });

  it('search: operador sem restrição não filtra por tipo', async () => {
    const { service, prisma } = build();

    await service.search('maria', { eventType: null });
    await service.search('maria');

    for (const [args] of prisma.student.findMany.mock.calls as unknown as Array<[{ where: object }]>) {
      expect(args.where).not.toHaveProperty('courseEventType');
    }
  });

  it('listSyncedCourses: aplica o escopo do operador', async () => {
    const { service, prisma } = build();

    await service.listSyncedCourses({ eventType: 'formation' });

    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { courseEventType: 'formation', courseActive: true } }),
    );
  });

  it('search e listSyncedCourses não enxergam turmas ocultas (inativas no Pai)', async () => {
    const { service, prisma } = build();

    await service.search('maria');
    await service.listSyncedCourses();

    for (const [args] of prisma.student.findMany.mock.calls as unknown as Array<[{ where: object }]>) {
      expect(args.where).toMatchObject({ courseActive: true });
    }
  });
});


describe('StudentsService — cidade do evento (courseCity)', () => {
  function build() {
    const tx = { student: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })), upsert: jest.fn() } };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      student: { findFirst: jest.fn() },
    };
    return { service: new StudentsService(prisma as never), tx, prisma };
  }

  it('o download grava a cidade no create e a atualiza no update', async () => {
    const { service, tx } = build();
    const item = replica(1);
    item.courseCity = 'Goiânia - GO';

    await service.replaceCourse(939, [item]);

    const args = tx.student.upsert.mock.calls[0][0];
    expect(args.create.courseCity).toBe('Goiânia - GO');
    expect(args.update.courseCity).toBe('Goiânia - GO');
  });

  it('consulta da cidade que falhou (sem courseCity) NÃO apaga a cidade já gravada', async () => {
    const { service, tx } = build();

    await service.replaceCourse(939, [replica(1)]);

    const args = tx.student.upsert.mock.calls[0][0];
    expect(args.create.courseCity).toBeNull();
    expect(args.update).not.toHaveProperty('courseCity');
  });

  it('findCourseCity devolve a cidade de qualquer aluno da turma que a tenha', async () => {
    const { service, prisma } = build();
    prisma.student.findFirst.mockResolvedValue({ courseCity: 'Curitiba - PR' });

    await expect(service.findCourseCity(939)).resolves.toBe('Curitiba - PR');
    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { courseId: 939, courseCity: { not: null } } }),
    );
  });

  it('findCourseCity devolve null quando nenhum aluno da turma tem cidade', async () => {
    const { service, prisma } = build();
    prisma.student.findFirst.mockResolvedValue(null);

    await expect(service.findCourseCity(939)).resolves.toBeNull();
  });
});
