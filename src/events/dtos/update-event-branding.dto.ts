import { IsOptional, IsString } from 'class-validator';

export class UpdateEventBrandingDto {
  @IsOptional()
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    text?: string;
  };

  @IsOptional()
  header?: {
    enabled?: boolean;
    backgroundImageUrl?: string;
    backgroundImageMobileUrl?: string;
  };

  @IsOptional()
  footer?: {
    enabled?: boolean;
    backgroundImageUrl?: string;
    backgroundImageMobileUrl?: string;
  };

  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  coverImageMobileUrl?: string;
}
