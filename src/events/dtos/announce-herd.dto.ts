import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class AnnounceHerdDto {
  // public = mensaje a todos; private = cada asistente ve el suyo personalizado
  @IsIn(['public', 'private'])
  type!: 'public' | 'private';

  // Clave del grupo. Sin ella: público → el grupo con más conectados;
  // privado → todos los conectados
  @IsOptional()
  @IsString()
  @MaxLength(100)
  key?: string;

  // Texto solo para este anuncio (admite {nombre}, {cantidad}, {grupo}, {total})
  @IsOptional()
  @IsString()
  @MaxLength(280)
  text?: string;
}
