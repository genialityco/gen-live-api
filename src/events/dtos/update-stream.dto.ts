import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateStreamDto {
  @IsIn(['vimeo'])
  provider!: 'vimeo';

  @IsString()
  @IsUrl({ require_tld: false }) // permite localhost si lo usaras
  url!: string;

  @IsOptional()
  meta?: Record<string, any>;
}
