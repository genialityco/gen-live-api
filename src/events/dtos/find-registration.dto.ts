import { IsString, IsNotEmpty, IsObject } from 'class-validator';

/**
 * DTO para buscar un registro existente por campos identificadores
 */
export class FindRegistrationDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsObject()
  @IsNotEmpty()
  identifiers: Record<string, string>; // { email: 'test@test.com', numId: '123456' }
}
