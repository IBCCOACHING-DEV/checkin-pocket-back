import { Body, Controller, HttpCode, HttpStatus, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/auth.guard';
import { OperatorScope } from '../auth/decorators/operator-scope.decorator';
import { CourseScope } from '../auth/course-scope';
import { CheckinRequestDto } from './dto/checkin-request.dto';
import { CheckinResult } from './interfaces/checkin-result.interface';
import { CheckinService } from './checkin.service';

@ApiTags('checkin')
@ApiBearerAuth()
@Controller('checkin')
@UseGuards(JwtAuthGuard)
export class CheckinController {
  private readonly logger = new Logger(CheckinController.name);

  constructor(private readonly checkinService: CheckinService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Realiza o check-in local de um aluno',
    description:
      'Localiza o aluno pelo token do QR Code na base local, marca a presença, cria o print_job da etiqueta e grava o evento no outbox para sincronização via RabbitMQ.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Check-in processado (ver campo "success" para o resultado).' })
  async checkin(@Body() dto: CheckinRequestDto, @OperatorScope() scope: CourseScope): Promise<CheckinResult> {
    this.logger.log(`Recebida solicitação de check-in — token=${dto.studentToken}`);
    return this.checkinService.performCheckin(dto, scope);
  }
}
