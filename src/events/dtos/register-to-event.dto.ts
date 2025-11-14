import {
  IsEmail,
  IsOptional,
  IsObject,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export class RegisterToEventDto {
  @IsEmail()
  @IsNotEmpty()
  email: string; // Email obligatorio (único campo del sistema)

  @IsString()
  @IsOptional()
  name?: string; // Nombre opcional extraído del formulario

  @IsObject()
  @IsOptional()
  formData?: Record<string, any>; // Todos los campos del formulario

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>; // Metadatos adicionales

  @IsString()
  @IsOptional()
  firebaseUID?: string; // Firebase UID para sesión anónima
}
