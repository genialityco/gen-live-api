import {
  IsString,
  IsArray,
  IsEnum,
  IsBoolean,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType, PollStatus } from '../schemas/poll.schema';

export class CreatePollOptionDto {
  @IsString()
  @MinLength(1)
  text: string;
}

export class CreatePollQuestionDto {
  @IsString()
  @MinLength(1)
  text: string;

  @IsEnum(QuestionType)
  type: QuestionType;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreatePollOptionDto)
  options: CreatePollOptionDto[];

  @IsBoolean()
  @IsOptional()
  required?: boolean;
}

export class CreatePollDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePollQuestionDto)
  questions: CreatePollQuestionDto[];

  @IsBoolean()
  @IsOptional()
  showStatistics?: boolean;
}

export class UpdatePollDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePollQuestionDto)
  @IsOptional()
  questions?: CreatePollQuestionDto[];

  @IsBoolean()
  @IsOptional()
  showStatistics?: boolean;
}

export class UpdatePollStatusDto {
  @IsEnum(PollStatus)
  status: PollStatus;
}

export class ToggleStatisticsDto {
  @IsBoolean()
  showStatistics: boolean;
}

export class PollAnswerDto {
  @IsString()
  questionId: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  selectedOptions: string[]; // IDs de las opciones seleccionadas
}

export class SubmitPollResponseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PollAnswerDto)
  answers: PollAnswerDto[];

  @IsString()
  @IsOptional()
  orgAttendeeId?: string; // ID del OrgAttendee si está registrado
}
