import {
  IsOptional,
  IsString,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class BrandingColorsDto {
  @IsOptional() @IsString() primary?: string;
  @IsOptional() @IsString() secondary?: string;
  @IsOptional() @IsString() accent?: string;
  @IsOptional() @IsString() background?: string;
  @IsOptional() @IsString() text?: string;
}

class BrandingHeaderDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() backgroundImageUrl?: string;
  @IsOptional() @IsString() backgroundImageMobileUrl?: string;
}

class BrandingFooterDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() backgroundImageUrl?: string;
  @IsOptional() @IsString() backgroundImageMobileUrl?: string;
}

export class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BrandingColorsDto)
  colors?: BrandingColorsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BrandingHeaderDto)
  header?: BrandingHeaderDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BrandingFooterDto)
  footer?: BrandingFooterDto;
}
