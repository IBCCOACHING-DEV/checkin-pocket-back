import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../generated/prisma-remote/client';

/**
 * Wrapper de injeção de dependência em torno do PrismaClient de LEITURA do
 * banco MySQL PRINCIPAL do Checkin Pai (database "checkin").
 *
 * Diferente do LocalPrismaService (SQLite local), esta conexão é:
 *
 *  - Somente leitura: nunca usada para migrate/insert/update/delete, apenas
 *    para consultar `users`/`courses`/`students` do Pai.
 *  - "Lazy": o client não conecta em onModuleInit. Como o Checkin Pocket
 *    roda em eventos itinerantes (internet instável, IP mutável, hardware
 *    limitado), o boot do NestJS NUNCA pode travar ou falhar por causa da
 *    indisponibilidade do banco do Pai — quem decide quando tentar
 *    conectar/reconectar é o AuthSyncService (retry em loop) e as rotas de
 *    sincronização de turma, não este serviço.
 */
@Injectable()
export class RemotePaiPrismaService implements OnModuleDestroy {
  private readonly logger = new Logger(RemotePaiPrismaService.name);
  private clientInstance: PrismaClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Client Prisma conectado ao banco do Pai, criado sob demanda no primeiro
   * acesso (não bloqueia o bootstrap do Nest).
   */
  get client(): PrismaClient {
    if (!this.clientInstance) {
      this.clientInstance = this.createClient();
    }
    return this.clientInstance;
  }

  /**
   * Testa a conectividade com o banco do Pai sem nunca lançar exceção.
   * Usada pelo AuthSyncService no loop de retry do boot/refresh e pelas
   * rotas que expõem o status de sincronização ao front-end.
   */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.debug(
        `Banco do Pai indisponível: ${this.describeError(error)}`,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.clientInstance) {
      await this.clientInstance.$disconnect();
    }
  }

  private createClient(): PrismaClient {
    const adapter = new PrismaMariaDb({
      host: this.configService.get<string>('paiDatabase.host'),
      port: Number(this.configService.get<number>('paiDatabase.port')),
      user: this.configService.get<string>('paiDatabase.user'),
      password: this.configService.get<string>('paiDatabase.password'),
      database: this.configService.get<string>('paiDatabase.name'),
      connectionLimit: 5,
      connectTimeout: 5000,
      // MySQL 8 usa caching_sha2_password por padrão — sem SSL, o driver
      // precisa buscar a chave pública RSA do servidor pra criptografar a
      // senha na negociação inicial. Sem esta opção, a conexão trava até
      // estourar o timeout do pool em vez de autenticar (visto contra o
      // banco de produção do Pai, que usa esse plugin de autenticação).
      allowPublicKeyRetrieval: true,
    });

    return new PrismaClient({ adapter });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
