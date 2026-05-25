import { IsMongoId, IsOptional, IsString, Matches } from 'class-validator';

export class TransferEventDto {
  @IsMongoId()
  targetOrgId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{3,40}$/, {
    message: 'El slug solo puede contener letras minúsculas, números y guiones (3-40 caracteres)',
  })
  newSlug?: string;
}
