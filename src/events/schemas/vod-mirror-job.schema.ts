import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VodMirrorJobDocument = HydratedDocument<VodMirrorJob>;

/**
 * Fases de la copia de la grabación de un vivo a Bunny:
 * - waiting_source: esperando que el proveedor del vivo (Vimeo) termine de
 *   archivar la grabación y ofrezca un archivo descargable.
 * - importing: Bunny está descargando el archivo (aún sin ID de video).
 * - encoding: Bunny ya creó el video y lo está codificando.
 * - ready: hay URL HLS de Bunny (`bunnyUrl`).
 * - failed: se rindió (ver `lastError`); se reintenta al volver a pasar el
 *   evento a Finalizado/Repetición o con POST /events/:id/vod-mirror/retry.
 */
export const VOD_MIRROR_ACTIVE_STATUSES = [
  'waiting_source',
  'importing',
  'encoding',
] as const;

export type VodMirrorStatus =
  | (typeof VOD_MIRROR_ACTIVE_STATUSES)[number]
  | 'ready'
  | 'failed';

/**
 * Trabajo persistente (sobrevive reinicios de la API) que copia a Bunny la
 * grabación de un vivo hecho con Vimeo y, al terminar, deja el video de
 * Bunny como fuente por defecto de la repetición del evento.
 */
@Schema({ timestamps: true, collection: 'vod_mirror_jobs' })
export class VodMirrorJob {
  // Indexado por el índice compuesto { eventId, sourceUrl } de abajo.
  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true })
  eventSlug: string;

  @Prop({ required: true, enum: ['vimeo'] })
  sourceProvider: 'vimeo';

  /** URL de reproducción del vivo (la del estudio), tal cual. */
  @Prop({ required: true })
  sourceUrl: string;

  /** ID del video de Vimeo con la grabación (se resuelve en waiting_source). */
  @Prop({ default: '' })
  sourceVideoId: string;

  @Prop({
    type: String,
    required: true,
    enum: ['waiting_source', 'importing', 'encoding', 'ready', 'failed'],
    default: 'waiting_source',
  })
  status: VodMirrorStatus;

  /** Mensaje del último estado/espera, para mostrar en el Control del evento. */
  @Prop({ default: '' })
  detail: string;

  @Prop({ default: '' })
  lastError: string;

  /** Título único con el que se importa a Bunny (sirve para hallar su ID). */
  @Prop({ default: '' })
  bunnyTitle: string;

  @Prop({ default: '' })
  bunnyVideoId: string;

  @Prop({ default: '' })
  bunnyUrl: string;

  /** Si ya se puso como fuente por defecto del evento. */
  @Prop({ default: false })
  applied: boolean;

  @Prop({ default: 0 })
  attempts: number;

  /** Inicio de la fase actual (para los tiempos máximos de cada fase). */
  @Prop({ type: Date, default: () => new Date() })
  phaseStartedAt: Date;

  @Prop({ type: Date, default: () => new Date(), index: true })
  nextRunAt: Date;

  /** Bloqueo entre instancias de la API mientras se procesa. */
  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  @Prop({ type: Date })
  readyAt?: Date;
}

export const VodMirrorJobSchema = SchemaFactory.createForClass(VodMirrorJob);

// Un trabajo por grabación de origen y evento: volver a pasar a Repetición no
// vuelve a subir el mismo video.
VodMirrorJobSchema.index({ eventId: 1, sourceUrl: 1 }, { unique: true });
