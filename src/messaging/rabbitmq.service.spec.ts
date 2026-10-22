import { EventEmitter } from 'node:events';
import * as amqp from 'amqplib';
import { RabbitMqService } from './rabbitmq.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/** Canal/conexão falsos do amqplib — só o que o serviço usa. */
function fakeChannel() {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: jest.fn(async () => undefined),
    assertQueue: jest.fn(async () => undefined),
    bindQueue: jest.fn(async () => undefined),
    prefetch: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    consume: jest.fn(async () => undefined),
    ack: jest.fn(),
    nack: jest.fn(),
  });
  return channel;
}

function fakeConnection() {
  const channels: ReturnType<typeof fakeChannel>[] = [];
  const open = async () => {
    const channel = fakeChannel();
    channels.push(channel);
    return channel;
  };
  const connection = Object.assign(new EventEmitter(), {
    channels,
    createConfirmChannel: jest.fn(open),
    createChannel: jest.fn(open),
    close: jest.fn(async () => undefined),
  });
  return connection;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RabbitMqService', () => {
  const connect = amqp.connect as unknown as jest.Mock;
  let service: RabbitMqService;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    connect.mockReset();
    service = new RabbitMqService({ get: (_k: string, d: unknown) => d } as never);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('remonta os consumers registrados depois que a conexão cai e volta', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const setup = jest.fn(async () => undefined);

    service.onModuleInit();
    await flush();
    service.registerConsumer('checkin.sync.a', setup);
    await flush();
    expect(setup).toHaveBeenCalledTimes(1);

    first.emit('close'); // queda de rede
    jest.advanceTimersByTime(5000); // RECONNECT_DELAY_MS
    await flush();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it('consumer registrado antes de conectar é montado quando a conexão sobe', async () => {
    connect.mockResolvedValueOnce(fakeConnection());
    const setup = jest.fn(async () => undefined);

    service.registerConsumer('checkin.sync.a', setup);
    expect(setup).not.toHaveBeenCalled();

    service.onModuleInit();
    await flush();

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('ack num canal que fechou no meio do processamento não derruba o processo', async () => {
    const connection = fakeConnection();
    connect.mockResolvedValueOnce(connection);
    service.onModuleInit();
    await flush();

    await service.consume('fila', async () => undefined);
    const consumeChannel = connection.channels[connection.channels.length - 1];
    consumeChannel.ack.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    const onDelivery = (consumeChannel.consume.mock.calls[0] as unknown[])[1] as (msg: unknown) => void;

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    onDelivery({ content: Buffer.from('{}') });
    await flush();
    await flush();
    process.off('unhandledRejection', unhandled);

    expect(consumeChannel.ack).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('canais têm listener de erro (fechamento pelo broker não vira exceção não tratada)', async () => {
    const connection = fakeConnection();
    connect.mockResolvedValueOnce(connection);
    service.onModuleInit();
    await flush();
    await service.consume('fila', async () => undefined);

    for (const channel of connection.channels) {
      expect(() => channel.emit('error', new Error('PRECONDITION_FAILED'))).not.toThrow();
    }
  });
});
