import { IsNotEmpty, IsString, Matches, IsOptional } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  // solo minúsculas, números y guiones, 3-40 chars (subdominio)
  @IsString()
  @Matches(/^[a-z0-9-]{3,40}$/)
  domainSlug!: string;

  @IsString()
  @IsOptional()
  description?: string;
}
