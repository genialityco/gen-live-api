import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateUserAccountDto {
  @IsString()
  firebaseUid: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

export class UpdateUserAccountDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CheckRegistrationDto {
  @IsString()
  firebaseUid: string;

  @IsString()
  eventId: string;
}
