import { IsObject, IsOptional, IsString } from 'class-validator';

export class BulkImportRowDto {
  @IsObject()
  identifierValues: Record<string, any>;

  @IsObject()
  registrationData: Record<string, any>;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
