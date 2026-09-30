import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestTransferDto {
  @ApiProperty({ description: 'ID do Student no Checkin Pai (mesmo id da réplica local).' })
  @IsInt()
  studentId: number;

  @ApiProperty({ description: 'ID da turma (Course) do Checkin Pai, para auditoria/roteamento do evento.' })
  @IsInt()
  courseId: number;

  @ApiProperty({ description: 'Nome completo do NOVO titular do ingresso.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'E-mail do NOVO titular.' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Telefone do NOVO titular.' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({ description: 'CPF do NOVO titular (11 dígitos), se disponível.' })
  @IsString()
  @IsOptional()
  document?: string;

  @ApiPropertyOptional({ description: 'Nome para o crachá do NOVO titular.' })
  @IsString()
  @IsOptional()
  nickName?: string;

  @ApiPropertyOptional({ description: 'Observação livre sobre a transferência.' })
  @IsString()
  @IsOptional()
  note?: string;
}
