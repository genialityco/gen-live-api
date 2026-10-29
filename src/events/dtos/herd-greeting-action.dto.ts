import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Acción del asistente sobre el saludo entre colegas:
 * - impression: vio su anuncio individual (con o sin botón, lo decide el backend)
 * - greet: tocó «👋 Saludar» → avisa a los conectados de su grupo
 * - reply: devolvió un saludo recibido (greetingId) a quien lo envió
 */
export class HerdGreetingActionDto {
  @IsIn(['impression', 'greet', 'reply'])
  action!: 'impression' | 'greet' | 'reply';

  // Qué anuncio individual lo originó
  @IsOptional()
  @IsIn(['welcome', 'repeat', 'manual'])
  source?: 'welcome' | 'repeat' | 'manual';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  greetingId?: string;

  // Nombre que muestra la página (respaldo si no se encuentra su registro)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;
}
