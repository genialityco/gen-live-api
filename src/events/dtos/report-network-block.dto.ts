import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class NetworkProbeDto {
  @IsString()
  @MaxLength(200)
  host!: string;

  @IsIn(['ok', 'blocked', 'timeout'])
  result!: 'ok' | 'blocked' | 'timeout';

  @IsNumber()
  ms!: number;
}

export class ReportNetworkBlockDto {
  @IsString()
  @MaxLength(200)
  videoHost!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  videoUrl?: string;

  // Sin probes ni causa cuando solo se avisa que se recuperó
  @IsOptional()
  @IsIn(['video_blocked', 'all_blocked', 'timeout'])
  cause?: 'video_blocked' | 'all_blocked' | 'timeout';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => NetworkProbeDto)
  probes?: NetworkProbeDto[];

  @IsOptional()
  @IsBoolean()
  mobile?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  connectionType?: string;

  // true = el asistente ya pudo conectarse tras el bloqueo
  @IsOptional()
  @IsBoolean()
  recovered?: boolean;
}
