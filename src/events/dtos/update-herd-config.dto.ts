import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const HERD_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

class HerdGroupLabelDto {
  @IsString()
  @MaxLength(200)
  value!: string;

  // Plural ("endocrinólogos")
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  // Singular ("endocrinólogo")
  @IsOptional()
  @IsString()
  @MaxLength(80)
  singular?: string;
}

/** Apariencia del banner: mismas opciones que los anuncios del estudio */
class HerdStyleDto {
  @IsOptional()
  @IsIn(['bar', 'lowerThird', 'breaking', 'pill', 'glass'])
  template?: string;

  @IsOptional()
  @IsIn(['static', 'ticker'])
  mode?: string;

  @IsOptional()
  @IsIn(['sm', 'md', 'lg'])
  size?: string;

  @IsOptional()
  @IsIn(['slide', 'fade', 'wipe', 'pop'])
  animation?: string;

  @IsOptional()
  @IsIn(['system', 'inter', 'montserrat', 'oswald'])
  font?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  bgColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  textColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  accentColor?: string;
}

class HerdMessageDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  template?: string;

  @IsOptional()
  @IsIn(HERD_POSITIONS)
  position?: (typeof HERD_POSITIONS)[number];

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(60)
  durationSec?: number;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  label?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdStyleDto)
  style?: HerdStyleDto;

  // 0 = no repetir
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  repeatEverySec?: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  repeatTemplate?: string;
}

class HerdPrivateMessageDto extends HerdMessageDto {
  // Cuántos de cada grupo ven el mensaje de "eres la primera…" (0 = ninguno)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  firstCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  firstTemplate?: string;

  @IsOptional()
  @IsIn(['f', 'm'])
  ordinalGender?: 'f' | 'm';
}

class HerdPublicMessageDto extends HerdMessageDto {
  // false = no anunciar al crecer un grupo, solo cada repeatEverySec
  @IsOptional()
  @IsBoolean()
  announceOnGrowth?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  minIntervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  milestoneEvery?: number;
}

class HerdGreetingDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(HERD_POSITIONS)
  position?: (typeof HERD_POSITIONS)[number];

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(30)
  durationSec?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  cooldownSec?: number;

  // % al azar sin botón (experimento del saludo)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  holdoutPercent?: number;
}

export class UpdateHerdConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  fieldId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HerdGroupLabelDto)
  groupLabels?: HerdGroupLabelDto[];

  // Valores de las opciones que no reciben mensajes
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  excludedGroups?: string[];

  // % al azar en el grupo de control (sin mensajes)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  holdoutPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  accentColor?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdPrivateMessageDto)
  privateMessage?: HerdPrivateMessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdPublicMessageDto)
  publicMessage?: HerdPublicMessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdGreetingDto)
  greeting?: HerdGreetingDto;
}
