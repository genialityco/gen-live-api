import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsIn,
} from 'class-validator';

export class UpsertEmailTemplateDto {
  @IsString()
  @IsNotEmpty()
  orgId: string;

  @IsOptional()
  @IsString()
  eventId?: string;

  @IsIn(['WELCOME', 'INVITATION', 'REMINDER'])
  type: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
