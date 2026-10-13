import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Mesmos campos do formulário de cortesia do Checkin Pai
 * (`students/_form.html.erb`): turma, nome, nome do crachá, CPF e e-mail são
 * obrigatórios; telefone, titular e observação são opcionais.
 */
export class RegisterStudentDto {
  @ApiProperty({ description: 'ID da turma (Course) do Checkin Pai — precisa já estar baixada nesta estação.' })
  @IsInt()
  courseId: number;

  @ApiProperty({ description: 'Nome completo do aluno.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Nome para o crachá (identificação impressa).' })
  @IsString()
  @IsNotEmpty()
  nickName: string;

  @ApiProperty({ description: 'CPF do aluno (aceita máscara; só os dígitos são gravados).' })
  @IsString()
  @IsNotEmpty()
  document: string;

  @ApiProperty({ description: 'E-mail do aluno.' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'Telefone do aluno.' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Nome do titular do ingresso, quando diferente do aluno.' })
  @IsString()
  @IsOptional()
  ownerName?: string;

  @ApiPropertyOptional({ description: 'CPF do titular do ingresso, quando diferente do aluno.' })
  @IsString()
  @IsOptional()
  ownerDocument?: string;

  @ApiProperty({ description: 'Observação obrigatória: motivo/contexto do cadastro manual.' })
  @IsString()
  @IsNotEmpty()
  note: string;
}
