import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/auth.guard';
import { OperatorScope } from '../auth/decorators/operator-scope.decorator';
import { CourseScope } from '../auth/course-scope';
import { StudentRegistrationService } from './student-registration.service';
import { RegisterStudentDto } from './dto/register-student.dto';
import { RegistrationStatus } from './interfaces/registration-status.interface';

@ApiTags('student-registrations')
@ApiBearerAuth()
@Controller('student-registrations')
@UseGuards(JwtAuthGuard)
export class StudentRegistrationController {
  constructor(private readonly registrationService: StudentRegistrationService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Cadastra um aluno manualmente (síncrono local + assíncrono no Checkin Pai)',
    description:
      'Cria o aluno na réplica local na hora (id provisório + token) e publica `student.create.requested` no RabbitMQ. NÃO espera o Checkin Pai — o aluno já pode ser credenciado imediatamente. Use GET /student-registrations/:id para acompanhar a confirmação.',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Aluno criado localmente, aguardando confirmação do Pai.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Turma ainda não baixada nesta estação.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Já existe aluno com este CPF nesta turma.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Turma fora do perfil de acesso do operador.' })
  register(@Body() dto: RegisterStudentDto, @OperatorScope() scope: CourseScope): Promise<RegistrationStatus> {
    return this.registrationService.register(dto, scope);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Consulta o status de um cadastro de aluno',
    description: 'Usado pelo front para fazer polling até o status deixar de ser "pending".',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Status atual do cadastro.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cadastro não encontrado.' })
  getStatus(@Param('id') id: string): Promise<RegistrationStatus> {
    return this.registrationService.getStatus(id);
  }
}
