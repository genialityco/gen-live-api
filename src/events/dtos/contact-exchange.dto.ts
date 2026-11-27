import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Tarjeta de contacto que el asistente comparte (elige qué datos) */
export class SaveContactCardDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  // Internacional, solo dígitos (con o sin +): 573001234567
  @IsOptional()
  @IsString()
  @Matches(/^\+?\d{7,15}$/)
  whatsapp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;

  // Debe aceptar el texto de autorización de la organización
  @IsBoolean()
  @Equals(true)
  consent!: boolean;
}

/** Texto de autorización (habeas data) de la organización */
export class UpdateContactConsentDto {
  @IsString()
  @MaxLength(2000)
  consentText!: string;
}
