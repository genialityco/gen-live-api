import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { HERD_POSITIONS, HerdStyleDto } from './update-herd-config.dto';

export const MILESTONE_TYPES = [
  'watchMinutes',
  'pollsAnswered',
  'pollFirst',
  'greetingsSent',
  'totalMinutes',
  'firstToConnect',
  'frequentAttendee',
  'manual',
] as const;

export const MILESTONE_DELIVERIES = ['private', 'public', 'both'] as const;

class MilestoneDefDto {
  // Se guarda en cada logro otorgado: cambiarlo cuenta como un hito nuevo
  @IsString()
  @Matches(/^[\w-]{1,40}$/)
  id!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsIn(MILESTONE_TYPES)
  type!: (typeof MILESTONE_TYPES)[number];

  // Minutos, encuestas, posición (primeros N) o saludos, según el tipo
  @IsInt()
  @Min(1)
  @Max(600)
  threshold!: number;

  @IsIn(MILESTONE_DELIVERIES)
  delivery!: (typeof MILESTONE_DELIVERIES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(280)
  privateTemplate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  publicTemplate?: string;
}

class MilestoneChannelDto {
  @IsOptional()
  @IsIn(HERD_POSITIONS)
  position?: (typeof HERD_POSITIONS)[number];

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(30)
  durationSec?: number;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  label?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdStyleDto)
  style?: HerdStyleDto;
}

class MilestonePublicChannelDto extends MilestoneChannelDto {
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  minIntervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxNames?: number;
}

/** Logro manual: el admin felicita a uno o varios asistentes */
export class AwardMilestoneDto {
  @IsString()
  @Matches(/^[\w-]{1,40}$/)
  milestoneId!: string;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(/^[a-f\d]{24}$/i, { each: true })
  attendeeIds!: string[];
}

export class UpdateMilestonesConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  holdoutPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  accentColor?: string;

  // Pestaña «Mis logros» en la página del asistente
  @IsOptional()
  @IsBoolean()
  showToAttendee?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => MilestoneChannelDto)
  privateMessage?: MilestoneChannelDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MilestonePublicChannelDto)
  publicMessage?: MilestonePublicChannelDto;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MilestoneDefDto)
  items!: MilestoneDefDto[];
}
