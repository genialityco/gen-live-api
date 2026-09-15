import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

class StreamEntryDto {
  @IsString()
  provider!: string;

  @IsString()
  url!: string;

  @IsOptional()
  meta?: Record<string, any>;
}

export class UpdateStreamsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StreamEntryDto)
  streams!: StreamEntryDto[];
}
