import { IsBoolean } from 'class-validator';

export class UpdateEmergencyModeDto {
  @IsBoolean()
  active!: boolean;
}
