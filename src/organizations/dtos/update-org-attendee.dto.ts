import {
  IsEmail,
  IsOptional,
  IsString,
  IsObject,
} from 'class-validator';

export class UpdateOrgAttendeeDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  registrationData?: Record<string, any>;
}
