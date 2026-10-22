import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { ConsumeMessage } from 'amqplib';
import {
  CHECKIN_EVENTS_EXCHANGE,
  CHECKIN_EVENTS_EXCHANGE_DLX,
  PRINT_JOBS_DLQ_QUEUE,
  PRINT_JOBS_DLX_EXCHANGE,
  PRINT_JOB_FAILED_ROUTING_KEY,
} from './rabbitmq.constants';

// Tipos inferidos diretamente da lib instalada (em vez de importar nomes de
// tipo específicos, que mudaram entre versões do amqplib — ex.: `Connection`
// virou `ChannelModel` na v0.10). Isso mantém o código resiliente a upgrades.
type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

export interface QueueDeclarationOptions {
  durable?: boolean;
  arguments?: Record<string, string | number>;
}

export type MessageHandler = (content: Buffer, msg: ConsumeMessage) => Promise<void>;

/** Declara filas/bindings e chama `consume` — roda de novo a cada (re)conexão. */
export type ConsumerSetup = () => Promise<void>;

const RECONNECT_DELAY_MS = 5000;
// Sem isso, um broker inalcançável (estação offline) só falha depois do
// timeout de TCP do SO (~20s+ no Windows).
const CONNECT_TIMEOUT_MS = 10000;
const CONSUMER_SETUP_RETRY_MS = 15000;

/**
 * Cliente RabbitMQ de baixo nível (amqplib) exposto como provider Nest.
 *
 * Responsabilidades:
 *  - Manter a conexão/canal de publicação com reconexão automática.
 *  - Declarar a topologia base (exchanges de eventos de check-in e a
 *    dead-letter exchange/queue de impressão).
 *  - Oferecer `publish` (confirm channel — só resolve `true` após ACK do
 *    broker, requisito do Outbox Pattern) e `consume` (com ack manual e
 *    nack -> dead-letter em caso de erro no handler).
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: AmqpConnection | null = null;
  private publishChannel: AmqpConfirmChannel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private shuttingDown = false;
  // Canais de consumo morrem junto com a conexão: os consumers registrados
  // aqui são montados de novo a cada conexão bem-sucedida (ver connect()).
  private readonly consumerSetups = new Map<string, ConsumerSetup>();
  // Muda a cada conexão nova — um retry de setup agendado numa conexão que já
  // caiu não roda de novo na seguinte (a própria reconexão já remonta tudo).
  private connectionGeneration = 0;
  private ready = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // Fire-and-forget deliberado: o boot do Nest (e portanto o app.listen)
    // NÃO pode esperar o broker — a estação precisa funcionar offline. Se a
    // conexão falhar, connect() agenda o retry sozinho.
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.publishChannel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private get url(): string {
    return this.configService.get<string>(
      'rabbitmq.url',
      'amqp://guest:guest@localhost:5672',
    );
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.shuttingDown) {
      return;
    }
    this.connecting = true;

    try {
      const connection = await amqp.connect(this.url, { timeout: CONNECT_TIMEOUT_MS });
      this.connection = connection;

      connection.on('close', () => {
        // Só a conexão ATUAL zera o estado — o 'close' atrasado de uma
        // conexão antiga não pode derrubar uma conexão nova que já está de pé.
        if (this.connection !== connection) {
          return;
        }
        this.ready = false;
        this.publishChannel = null;
        this.connection = null;
        if (!this.shuttingDown) {
          this.logger.warn(
            `Conexão RabbitMQ encerrada. Tentando reconectar em ${RECONNECT_DELAY_MS}ms...`,
          );
          this.scheduleReconnect();
        }
      });

      connection.on('error', (error: Error) => {
        this.logger.error(`Erro na conexão RabbitMQ: ${error.message}`);
      });

      this.publishChannel = await this.openPublishChannel(connection);
      await this.declareTopology(this.publishChannel);

      this.connectionGeneration += 1;
      this.ready = true;
      this.logger.log('Conectado ao RabbitMQ e topologia base declarada.');

      for (const [name, setup] of this.consumerSetups) {
        void this.runConsumerSetup(name, setup, this.connectionGeneration);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Falha ao conectar ao RabbitMQ: ${message}`);
      // Conexão aberta mas sem canal/topologia: descarta para a próxima
      // tentativa não deixar uma conexão órfã aberta no broker.
      const failed = this.connection;
      this.connection = null;
      this.publishChannel = null;
      void failed?.close().catch(() => undefined);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Canal de publicação com listeners próprios: sem listener de 'error', o
   * fechamento do canal pelo broker vira exceção não tratada e derruba o
   * processo; e um canal fechado com a conexão ainda viva precisa ser
   * descartado para o próximo publish abrir outro.
   */
  private async openPublishChannel(connection: AmqpConnection): Promise<AmqpConfirmChannel> {
    const channel = await connection.createConfirmChannel();
    channel.on('error', (error: Error) => {
      this.logger.error(`Canal de publicação RabbitMQ fechado com erro: ${error.message}`);
    });
    channel.on('close', () => {
      if (this.publishChannel === channel) {
        this.publishChannel = null;
      }
    });
    return channel;
  }

  /**
   * Registra um consumer para ser montado AGORA (se conectado) e de novo a
   * CADA reconexão. Antes, cada consumer registrava uma única vez: depois de
   * qualquer queda de rede a estação parava de receber eventos das outras até
   * o app ser reaberto.
   */
  registerConsumer(name: string, setup: ConsumerSetup): void {
    this.consumerSetups.set(name, setup);
    if (this.ready) {
      void this.runConsumerSetup(name, setup, this.connectionGeneration);
    }
  }

  private async runConsumerSetup(name: string, setup: ConsumerSetup, generation: number): Promise<void> {
    try {
      await setup();
      this.logger.log(`Consumer "${name}" ativo.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Não foi possível ativar o consumer "${name}": ${message}. Nova tentativa em ${CONSUMER_SETUP_RETRY_MS}ms.`,
      );
      setTimeout(() => {
        if (!this.shuttingDown && this.ready && this.connectionGeneration === generation) {
          void this.runConsumerSetup(name, setup, generation);
        }
      }, CONSUMER_SETUP_RETRY_MS);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, RECONNECT_DELAY_MS);
  }

  private async declareTopology(channel: AmqpConfirmChannel): Promise<void> {
    await channel.assertExchange(CHECKIN_EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(CHECKIN_EVENTS_EXCHANGE_DLX, 'topic', { durable: true });
    await channel.assertExchange(PRINT_JOBS_DLX_EXCHANGE, 'topic', { durable: true });

    await channel.assertQueue(PRINT_JOBS_DLQ_QUEUE, { durable: true });
    await channel.bindQueue(
      PRINT_JOBS_DLQ_QUEUE,
      PRINT_JOBS_DLX_EXCHANGE,
      PRINT_JOB_FAILED_ROUTING_KEY,
    );
  }

  /**
   * Publica uma mensagem persistente em `exchange`/`routingKey` e só
   * resolve `true` depois que o broker confirma o recebimento (confirm
   * channel). Usado pelo Outbox worker: o registro só é removido do SQLite
   * quando esta promise resolve `true`.
   */
  async publish(
    exchange: string,
    routingKey: string,
    payload: object,
  ): Promise<boolean> {
    let channel: AmqpConfirmChannel;

    try {
      channel = await this.ensurePublishChannel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Publish abortado — broker indisponível: ${message}`);
      return false;
    }

    const buffer = Buffer.from(JSON.stringify(payload));

    return new Promise<boolean>((resolve) => {
      try {
        channel.publish(
          exchange,
          routingKey,
          buffer,
          { persistent: true, contentType: 'application/json' },
          (error) => {
            if (error) {
              this.logger.error(`Publish não confirmado pelo broker: ${error.message}`);
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Falha síncrona ao publicar no RabbitMQ: ${message}`);
        resolve(false);
      }
    });
  }

  private async ensurePublishChannel(): Promise<AmqpConfirmChannel> {
    if (!this.publishChannel && this.connection && this.ready) {
      // Só o canal caiu (a conexão segue viva): abre outro nela mesma.
      this.publishChannel = await this.openPublishChannel(this.connection);
    }
    if (!this.publishChannel) {
      await this.connect();
    }
    if (!this.publishChannel) {
      throw new Error('Canal de publicação RabbitMQ indisponível.');
    }
    return this.publishChannel;
  }

  private async ensureConnection(): Promise<AmqpConnection> {
    if (!this.connection) {
      await this.connect();
    }
    if (!this.connection) {
      throw new Error('Conexão RabbitMQ indisponível.');
    }
    return this.connection;
  }

  /**
   * Declara (idempotentemente) uma fila e faz o binding em uma exchange.
   */
  async assertAndBindQueue(
    queue: string,
    exchange: string,
    bindingPattern: string,
    queueOptions: QueueDeclarationOptions = {},
  ): Promise<void> {
    const connection = await this.ensureConnection();
    const channel = await connection.createChannel();
    // Ex.: fila já existente com argumentos diferentes (PRECONDITION_FAILED):
    // o broker fecha o canal — o assertQueue rejeita e o erro sobe por ele;
    // o listener só evita que o 'error' do canal derrube o processo.
    channel.on('error', (error: Error) => {
      this.logger.error(`Canal de declaração da fila "${queue}" fechado com erro: ${error.message}`);
    });
    try {
      await channel.assertQueue(queue, { durable: true, ...queueOptions });
      await channel.bindQueue(queue, exchange, bindingPattern);
    } finally {
      await channel.close().catch(() => undefined);
    }
  }

  /**
   * Abre um canal de consumo dedicado (com prefetch) e registra `handler`
   * para cada mensagem recebida. Em caso de sucesso, faz ACK manual; em
   * caso de erro, faz NACK sem requeue — a mensagem cai na dead-letter
   * exchange configurada na fila (ver `assertAndBindQueue`).
   */
  async consume(queue: string, handler: MessageHandler, prefetch = 10): Promise<void> {
    const connection = await this.ensureConnection();
    const channel: AmqpChannel = await connection.createChannel();
    channel.on('error', (error: Error) => {
      this.logger.error(`Canal de consumo da fila "${queue}" fechado com erro: ${error.message}`);
    });
    await channel.prefetch(prefetch);

    // ack/nack num canal que fechou no meio do processamento (queda de rede)
    // LANÇA na hora; sem este try, a rejeição ficava sem tratamento e o Node
    // encerrava o backend. A mensagem não confirmada volta para a fila sozinha.
    const settle = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Não foi possível confirmar a mensagem da fila "${queue}" (canal fechado?): ${message}`);
      }
    };

    await channel.consume(queue, (msg) => {
      if (!msg) {
        return;
      }

      handler(msg.content, msg).then(
        () => settle(() => channel.ack(msg)),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Falha ao processar mensagem da fila "${queue}": ${message}`);
          settle(() => channel.nack(msg, false, false));
        },
      );
    });

    this.logger.log(`Consumidor registrado na fila "${queue}" (prefetch=${prefetch}).`);
  }
}
