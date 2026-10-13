import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { jwtOptions } from './jwt/jwt.config';
import { ApiKeyStrategy } from './strategies/api-key.strategy';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSyncModule } from '../auth-sync/auth-sync.module';
import { PaiSyncModule } from '../pai-sync/pai-sync.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({ ...jwtOptions, global: true }),
    // Necessário para o AuthController expor GET /auth/sync-status.
    AuthSyncModule,
    // Necessário para o POST /auth/sync também baixar as turmas ativas.
    PaiSyncModule,
  ],
  controllers: [AuthController],
  providers: [ApiKeyStrategy, AuthService],
  exports: [JwtModule],
})
export class AuthModule {}
