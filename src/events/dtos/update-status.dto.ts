import { IsEnum, IsOptional, IsDate } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateStatusDto {
  @IsEnum(['upcoming', 'live', 'ended', 'replay'])
  status!: 'upcoming' | 'live' | 'ended' | 'replay';

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endedAt?: Date;
}
