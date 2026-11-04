import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HerdAnnouncementDocument = HydratedDocument<HerdAnnouncement>;

/**
 * Historial de anuncios públicos de manada. En RTDB (/herd/{eventId}/public)
 * cada anuncio pisa al anterior; aquí queda uno por anuncio para poder
 * cruzarlos después con la audiencia (informe del experimento).
 */
@Schema({
  collection: 'herd_announcements',
  timestamps: { createdAt: true, updatedAt: false },
})
export class HerdAnnouncement {
  @Prop({ required: true, index: true })
  eventId!: string;

  // growth = hito al crecer el grupo · repeat = repetición periódica ·
  // manual = disparado desde el panel
  @Prop({ required: true, enum: ['growth', 'repeat', 'manual'] })
  trigger!: 'growth' | 'repeat' | 'manual';

  @Prop({ required: true })
  groupKey!: string;

  @Prop()
  groupLabel?: string;

  // Conteo mostrado en el anuncio (el hito, si se usan hitos)
  @Prop({ required: true })
  count!: number;

  // Conectados del grupo en ese momento (puede superar al hito mostrado)
  @Prop()
  groupConnected?: number;

  // Conectados con grupo en total y audiencia que ve mensajes
  @Prop()
  total?: number;

  @Prop()
  audience?: number;

  @Prop()
  registered?: number;

  @Prop()
  registeredTotal?: number;

  // Texto propio del anuncio manual (si lo hubo)
  @Prop()
  text?: string;

  createdAt?: Date;
}

export const HerdAnnouncementSchema =
  SchemaFactory.createForClass(HerdAnnouncement);
HerdAnnouncementSchema.index({ eventId: 1, createdAt: 1 });
