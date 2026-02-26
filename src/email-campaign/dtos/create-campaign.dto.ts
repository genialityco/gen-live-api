import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AudienceFiltersDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eventUserStatus?: string[];
}

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  orgId: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  templateId: string;

  @IsIn(['event_users', 'org_attendees', 'both'])
  targetAudience: 'event_users' | 'org_attendees' | 'both';

  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceFiltersDto)
  audienceFilters?: AudienceFiltersDto;
}
