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

  @IsString()
  @MaxLength(80)
  label!: string;
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
}

class HerdPublicMessageDto extends HerdMessageDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(40)
  accentColor?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdMessageDto)
  privateMessage?: HerdMessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => HerdPublicMessageDto)
  publicMessage?: HerdPublicMessageDto;
}
