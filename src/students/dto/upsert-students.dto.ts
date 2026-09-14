import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StudentReplicaDto {
  @ApiProperty({ description: 'ID do Student no Checkin Pai (mesmo ID, réplica local).' })
  @IsInt()
  id: number;

  @ApiProperty({ description: 'ID do Course (turma/evento) no Checkin Pai.' })
  @IsInt()
  courseId: number;

  @ApiProperty({ description: 'Nome da turma/evento (denormalizado para a etiqueta).' })
  @IsString()
  @MinLength(1)
  courseName: string;

  @ApiProperty({ description: 'Nome do aluno.' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ description: 'Token do voucher/QR Code — usado para localizar o aluno no check-in.' })
  @IsString()
  @MinLength(1)
  token: string;

  @ApiProperty({ required: false, description: 'E-mail do aluno — usado na busca por nome/e-mail/documento.' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false, description: 'Documento (CPF/RG) do aluno — usado na busca.' })
  @IsOptional()
  @IsString()
  document?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  ibcCustomerId?: number;

  @ApiProperty({
    required: false,
    description: 'Data de início da turma no Checkin Pai (formato "YYYY-MM-DD"), usada para bloquear check-in fora do período do evento.',
  })
  @IsOptional()
  @IsString()
  courseEventDate?: string;

  @ApiProperty({
    required: false,
    description: 'Data de término da turma (mesmo formato de courseEventDate).',
  })
  @IsOptional()
  @IsString()
  courseEventDateEnd?: string;
}

/**
 * Payload de sincronização em lote da réplica local de Student. Populado
 * periodicamente a partir do Checkin Pai (ou de uma exportação de turma),
 * para que o check-in funcione mesmo com a rede instável.
 */
export class UpsertStudentsDto {
  @ApiProperty({ type: [StudentReplicaDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StudentReplicaDto)
  students: StudentReplicaDto[];
}
