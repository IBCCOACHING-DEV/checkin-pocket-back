import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchTransferQueryDto {
  @ApiProperty({
    description:
      'CPF (inteiro ou parcial), nome ou e-mail do titular atual do ingresso — busca direta no banco do Checkin Pai.',
    example: 'maria silva',
  })
  @IsString()
  @MinLength(3)
  q: string;
}
