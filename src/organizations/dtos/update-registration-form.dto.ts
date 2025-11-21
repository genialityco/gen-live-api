import {
  IsOptional,
  IsString,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsIn,
  IsNumber,
  IsDefined,
} from 'class-validator';
import { Type } from 'class-transformer';

class FormFieldOptionDto {
  @IsString() label: string;
  @IsString() value: string;
  @IsOptional() @IsString() parentValue?: string;
}

class ConditionalRuleDto {
  @IsString() field: string;
  @IsIn(['equals', 'notEquals', 'contains', 'notContains'])
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains';
  @IsDefined() // Asegura que el campo se preserve durante la validación (acepta cualquier tipo)
  value: any;
}

class ConditionalLogicDto {
  @IsIn(['show', 'hide', 'enable', 'disable', 'require'])
  action: 'show' | 'hide' | 'enable' | 'disable' | 'require';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionalRuleDto)
  conditions: ConditionalRuleDto[];

  @IsIn(['and', 'or'])
  logic: 'and' | 'or';
}

class FormFieldValidationDto {
  @IsOptional() @IsNumber() min?: number;
  @IsOptional() @IsNumber() max?: number;
  @IsOptional() @IsNumber() minLength?: number;
  @IsOptional() @IsNumber() maxLength?: number;
  @IsOptional() @IsString() pattern?: string;
}

class FormFieldDto {
  @IsString() id: string;

  @IsIn(['text', 'email', 'tel', 'number', 'select', 'checkbox', 'textarea'])
  type:
    | 'text'
    | 'email'
    | 'tel'
    | 'number'
    | 'select'
    | 'checkbox'
    | 'textarea';

  @IsString() label: string;

  @IsOptional() @IsString() placeholder?: string;

  @IsBoolean() required: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormFieldOptionDto)
  options?: FormFieldOptionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => FormFieldValidationDto)
  validation?: FormFieldValidationDto;

  @IsNumber() order: number;

  // Propiedades avanzadas
  @IsOptional() @IsString() helpText?: string;

  @IsOptional() defaultValue?: any;

  @IsOptional() @IsBoolean() hidden?: boolean;

  @IsOptional() @IsBoolean() autoCalculated?: boolean;

  @IsOptional() @IsString() dependsOn?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionalLogicDto)
  conditionalLogic?: ConditionalLogicDto[];

  @IsOptional() @IsBoolean() isIdentifier?: boolean;
}

export class UpdateRegistrationFormDto {
  @IsBoolean() enabled: boolean;

  @IsOptional() @IsString() title?: string;

  @IsOptional() @IsString() description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  fields: FormFieldDto[];

  @IsOptional() @IsString() submitButtonText?: string;

  @IsOptional() @IsString() successMessage?: string;
}
