// src/modules/rewards/dto/grant-credits.dto.ts

import { IsNumber, IsString, IsNotEmpty, IsOptional, Min } from 'class-validator';

export class GrantCreditsDto {
  @IsNumber()
  @Min(0.01, { message: 'Credit grant amount must be greater than zero.' })
  amount: number;

  @IsString()
  @IsNotEmpty({ message: 'A reason for granting credits is required.' })
  reason: string;

  @IsString()
  @IsOptional()
  reference?: string;
}