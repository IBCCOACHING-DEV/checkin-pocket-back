import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/auth.guard';
import { TicketTransferService } from './ticket-transfer.service';
import { SearchTransferQueryDto } from './dto/search-transfer.dto';
import { RequestTransferDto } from './dto/request-transfer.dto';
import { TransferSearchResult } from './interfaces/transfer-search-result.interface';
import { TransferStatus } from './interfaces/transfer-status.interface';

@ApiTags('ticket-transfer')
@ApiBearerAuth()
@Controller('ticket-transfer')
@UseGuards(JwtAuthGuard)
export class TicketTransferController {
  constructor(private readonly ticketTransferService: TicketTransferService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Busca o(s) ingresso(s) de um CPF no Checkin Pai',
    description:
      'Consulta direta no banco do Pai (MySQL, somente leitura) — não depende da réplica local, funciona mesmo para turmas nunca sincronizadas nesta estação.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Ingressos encontrados para o CPF informado.' })
  search(@Query() query: SearchTransferQueryDto): Promise<TransferSearchResult[]> {
    return this.ticketTransferService.searchByDocument(query.document);
  }

  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Solicita a transferência de um ingresso (assíncrono)',
    description:
      'Grava a solicitação localmente e publica `transfer.requested` no RabbitMQ. NÃO espera o Checkin Pai/Coliseum — responde imediatamente com status "pending". Use GET /ticket-transfer/:id para acompanhar o resultado.',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Solicitação registrada, aguardando processamento.' })
  requestTransfer(@Body() dto: RequestTransferDto): Promise<TransferStatus> {
    return this.ticketTransferService.requestTransfer(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Consulta o status de uma solicitação de transferência',
    description: 'Usado pelo front para fazer polling até o status deixar de ser "pending".',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Status atual da transferência.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Transferência não encontrada.' })
  getStatus(@Param('id') id: string): Promise<TransferStatus> {
    return this.ticketTransferService.getStatus(id);
  }
}
