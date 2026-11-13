import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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

  // Grupo del anuncio (con varias manadas, cada anuncio es de una); sin él,
  // el grupo principal del asistente
  @IsOptional()
  @IsString()
  @MaxLength(200)
  groupKey?: string;

  // impression: ¿el botón se mostró de verdad? Su brazo puede tenerlo, pero
  // se oculta si hay pocos colegas conectados
  @IsOptional()
  @IsBoolean()
  buttonShown?: boolean;

  // Nombre que muestra la página (respaldo si no se encuentra su registro)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;
}
