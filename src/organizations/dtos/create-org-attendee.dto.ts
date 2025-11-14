import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateOrgAttendeeDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}
