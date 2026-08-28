import { IsBoolean } from 'class-validator';

export class UpdateCertificatesConfigDto {
  @IsBoolean()
  enabled!: boolean;
}
