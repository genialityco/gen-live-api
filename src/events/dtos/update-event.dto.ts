import {
  IsOptional,
  IsString,
  IsNotEmpty,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

class ScheduleDto {
  @IsDateString()
  @IsOptional()
  startsAt?: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;
}

export class UpdateEventDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @ValidateNested()
  @Type(() => ScheduleDto)
  @IsOptional()
  schedule?: ScheduleDto;
}
