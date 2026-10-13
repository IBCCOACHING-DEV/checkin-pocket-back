import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/auth.guard';
import { OperatorScope } from '../auth/decorators/operator-scope.decorator';
import { CourseScope } from '../auth/course-scope';
import { UpsertStudentsDto } from './dto/upsert-students.dto';
import { SearchStudentsQueryDto } from './dto/search-students.dto';
import { StudentsService, StudentSearchResult, SyncedCourseSummary } from './students.service';

@ApiTags('students')
@ApiBearerAuth()
@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentsController {
  private readonly logger = new Logger(StudentsController.name);

  constructor(private readonly studentsService: StudentsService) {}

  @Get('courses')
  @ApiOperation({
    summary: 'Lista as turmas já sincronizadas nesta estação',
    description:
      'Consulta apenas a réplica local (SQLite) — funciona offline. Usada para popular o seletor de turma na tela de check-in.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Turmas sincronizadas nesta estação.' })
  listSyncedCourses(@OperatorScope() scope: CourseScope): Promise<SyncedCourseSummary[]> {
    return this.studentsService.listSyncedCourses(scope);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Busca alunos já sincronizados por nome, e-mail ou documento',
    description:
      'Alternativa ao QR Code para quando o operador não tem o voucher em mãos. Consulta apenas a réplica local (SQLite) — funciona offline. Retorna a turma e o status de check-in de cada resultado.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Alunos encontrados na réplica local.' })
  search(
    @Query() query: SearchStudentsQueryDto,
    @OperatorScope() scope: CourseScope,
  ): Promise<StudentSearchResult[]> {
    return this.studentsService.search(query.q, scope);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sincroniza (upsert) a réplica local de alunos/ingressos',
    description:
      'Recebe um lote de alunos (id, nome, turma, token) do Checkin Pai e grava/atualiza a réplica local usada pelo check-in offline.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Réplica local atualizada.' })
  async sync(@Body() dto: UpsertStudentsDto): Promise<{ success: boolean; upserted: number }> {
    this.logger.log(`Recebida sincronização de ${dto.students.length} aluno(s).`);
    const upserted = await this.studentsService.upsertMany(dto.students);
    return { success: true, upserted };
  }
}
