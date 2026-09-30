import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchTransferQueryDto {
  @ApiProperty({
    description: 'CPF (documento) do titular atual do ingresso — busca direta no banco do Checkin Pai.',
    example: '12345678900',
  })
  @IsString()
  @MinLength(3)
  document: string;
}
