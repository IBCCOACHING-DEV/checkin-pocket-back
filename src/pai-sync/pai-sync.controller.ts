import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/auth.guard';
import { PaiSyncService } from './pai-sync.service';
import { PaiCourseSummary } from './interfaces/pai-course.interface';
import { CourseSyncResult } from './interfaces/course-sync-result.interface';

@ApiTags('pai-sync')
@ApiBearerAuth()
@Controller('pai')
@UseGuards(JwtAuthGuard)
export class PaiSyncController {
  constructor(private readonly paiSyncService: PaiSyncService) {}

  @Get('courses')
  @ApiOperation({
    summary: 'Lista os Courses ativos no Checkin Pai',
    description:
      'Consulta o banco do Pai diretamente (MySQL, somente leitura) e retorna apenas as turmas ativas — usado na tela "Baixar turma". Nunca copia a base inteira.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Lista de turmas ativas.' })
  listCourses(): Promise<PaiCourseSummary[]> {
    return this.paiSyncService.listActiveCourses();
  }

  @Post('courses/:id/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Baixa os alunos de UMA turma específica do Checkin Pai',
    description:
      'Sincroniza (upsert) apenas os Students do Course informado para a réplica local (SQLite) — a turma que o operador escolheu clicar em "sincronizar".',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Turma sincronizada.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Course não encontrado no Checkin Pai.' })
  syncCourse(@Param('id', ParseIntPipe) id: number): Promise<CourseSyncResult> {
    return this.paiSyncService.syncCourse(id);
  }

  @Post('courses/sync-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resincroniza todas as turmas já baixadas nesta estação',
    description:
      'Repete o download (upsert) de cada turma que esta estação já possui localmente — usado pelo botão "Atualizar turmas baixadas" e automaticamente logo após o login.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Turmas resincronizadas.' })
  syncAllKnownCourses(): Promise<CourseSyncResult[]> {
    return this.paiSyncService.syncAllKnownCourses();
  }
}
