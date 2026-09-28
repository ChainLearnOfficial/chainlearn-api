import { IsNumber, IsPositive, IsString, IsOptional } from 'class-validator';

export class DeductCreditsDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  reason: string;

  @IsString()
  @IsOptional()
  reference?: string;
}