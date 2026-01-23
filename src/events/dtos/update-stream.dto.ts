import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateStreamDto {
  @IsIn(['vimeo', 'mux'])
  provider!: 'vimeo' | 'mux';

  @IsString()
  @IsUrl({ require_tld: false }) // permite localhost si lo usaras
  url!: string;

  @IsOptional()
  meta?: Record<string, any>;
}
