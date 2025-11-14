import { IsEnum } from 'class-validator';

export class UpdateStatusDto {
  @IsEnum(['upcoming', 'live', 'ended', 'replay'])
  status!: 'upcoming' | 'live' | 'ended' | 'replay';
}
