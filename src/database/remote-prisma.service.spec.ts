import { RemotePaiPrismaService } from './remote-prisma.service';

describe('RemotePaiPrismaService#findEventCity', () => {
  function build(ibcName: string | null = 'ibcsystem_production') {
    const configService = { get: jest.fn((key: string) => (key === 'paiDatabase.ibcName' ? ibcName : undefined)) };
    const service = new RemotePaiPrismaService(configService as never);
    const queryRawUnsafe = jest.fn();
    Object.defineProperty(service, 'client', { get: () => ({ $queryRawUnsafe: queryRawUnsafe }) });
    return { service, queryRawUnsafe };
  }

  it('lê ces.cidade da turma pelo online_reference, no banco do IBC, parametrizado', async () => {
    const { service, queryRawUnsafe } = build();
    queryRawUnsafe.mockResolvedValue([{ cidade: '  Goiânia - GO ' }]);

    await expect(service.findEventCity(11229)).resolves.toBe('Goiânia - GO');

    const [sql, ref] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('`ibcsystem_production`.turmas');
    expect(sql).toContain('`ibcsystem_production`.ces');
    expect(sql).toContain('t.id = ?');
    expect(ref).toBe(11229);
  });

  it('sem online_reference não consulta nada', async () => {
    const { service, queryRawUnsafe } = build();

    await expect(service.findEventCity(null)).resolves.toBeNull();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('turma sem centro de eventos ou cidade vazia vira null', async () => {
    const { service, queryRawUnsafe } = build();

    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(service.findEventCity(1)).resolves.toBeNull();

    queryRawUnsafe.mockResolvedValueOnce([{ cidade: '   ' }]);
    await expect(service.findEventCity(1)).resolves.toBeNull();
  });

  it('falha de permissão/rede nunca lança: devolve null (o download da turma segue)', async () => {
    const { service, queryRawUnsafe } = build();
    queryRawUnsafe.mockRejectedValue(new Error('SELECT command denied to user'));

    await expect(service.findEventCity(11229)).resolves.toBeNull();
    await expect(service.findEventCity(11230)).resolves.toBeNull();
  });

  it.each(['ibc; DROP TABLE ces', 'a`b', '', null])(
    'nome de banco inválido (%p) é recusado sem montar SQL',
    async (name) => {
      const { service, queryRawUnsafe } = build(name as string | null);

      await expect(service.findEventCity(11229)).resolves.toBeNull();
      expect(queryRawUnsafe).not.toHaveBeenCalled();
    },
  );
});
