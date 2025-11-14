import { IsString, IsNotEmpty, IsObject, IsOptional } from 'class-validator';

/**
 * DTO para actualizar un registro existente
 */
export class UpdateRegistrationDto {
  @IsString()
  @IsNotEmpty()
  attendeeId: string;

  @IsObject()
  @IsNotEmpty()
  formData: Record<string, any>; // Datos actualizados del formulario

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
