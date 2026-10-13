import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginResult } from './interfaces/login-result.interface';
import { AuthSyncService } from '../auth-sync/auth-sync.service';
import { AuthSyncStatus } from '../auth-sync/auth-sync.types';
import { PaiSyncService } from '../pai-sync/pai-sync.service';
import { ForceSyncResult } from './interfaces/force-sync-result.interface';

// Este controller NÃO usa @UseGuards(JwtAuthGuard): é ele quem emite os
// tokens que as demais rotas (checkin/students/print/pai-sync) exigem, e
// precisa ficar acessível mesmo antes do operador ter um JWT.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authSyncService: AuthSyncService,
    private readonly paiSyncService: PaiSyncService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login local do operador',
    description:
      'Valida e-mail/senha contra o cache local de operadores (sincronizado do Checkin Pai) e emite o JWT usado pelas demais rotas desta estação.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Login realizado, retorna o accessToken.' })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Credenciais inválidas ou operador ainda não sincronizado nesta estação.',
  })
  async login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  @Get('sync-status')
  @ApiOperation({
    summary: 'Status da sincronização de autenticação com o Checkin Pai',
    description:
      'Usado pela tela de login do front-end para indicar se a estação já sincronizou os operadores ao menos uma vez desde que foi ligada.',
  })
  getSyncStatus(): Promise<AuthSyncStatus> {
    return this.authSyncService.getStatus();
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Força uma sincronização imediata de operadores e baixa as turmas ativas',
    description:
      'Usado pelo botão "Sincronizar agora" da tela de login — dispara uma tentativa fora do ritmo normal do loop de retry/refresh e, se o Checkin Pai respondeu, já baixa/atualiza todas as turmas ativas (o operador ainda não tem JWT nesse momento, por isso o download roda aqui no servidor local). Retorna o status atualizado.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Status atualizado após a tentativa (ver campo "lastError" para saber se falhou e "coursesSync" para o resultado do download das turmas).' })
  async forceSync(): Promise<ForceSyncResult> {
    await this.authSyncService.forceSync();
    const status = await this.authSyncService.getStatus();

    // Pai inalcançável: não adianta tentar baixar turmas (só somaria outro timeout).
    const coursesSync = status.lastError ? null : await this.paiSyncService.syncActiveCourses();

    return { ...status, coursesSync };
  }
}
