import { IsBoolean } from 'class-validator';

export class UpdateBunnyReplayConfigDto {
  @IsBoolean()
  enabled!: boolean;
}
