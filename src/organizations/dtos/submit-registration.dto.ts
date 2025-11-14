import { IsString, IsObject } from 'class-validator';

export class SubmitRegistrationDto {
  @IsString() orgId: string;

  @IsString() eventId?: string; // Opcional: si se registra para un evento específico

  @IsObject() responses: Record<string, any>; // fieldId: valor
}
