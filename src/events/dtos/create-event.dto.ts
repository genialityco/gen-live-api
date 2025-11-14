import {
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateEventDto {
  @IsMongoId() orgId!: string;

  @IsString() @Matches(/^[a-z0-9-]{3,40}$/) slug!: string;

  @IsString() @IsNotEmpty() title!: string;

  @IsString() @IsOptional() description?: string;

  @IsOptional() schedule?: { startsAt?: Date; endsAt?: Date };

  @IsOptional() stream?: { url?: string; provider?: string };
}
