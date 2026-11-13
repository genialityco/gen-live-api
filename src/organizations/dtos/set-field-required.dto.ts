import { IsBoolean } from 'class-validator';

export class SetFieldRequiredDto {
  @IsBoolean()
  required!: boolean;
}
