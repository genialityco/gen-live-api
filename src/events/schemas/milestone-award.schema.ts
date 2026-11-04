import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { MilestoneType } from './event.schema';

export type MilestoneAwardDocument = HydratedDocument<MilestoneAward>;

/**
 * Logro otorgado a un asistente (uno por asistente y hito). Si cae en el
 * grupo de control (`holdout`) se registra igual, pero no se le felicita:
 * así se puede comparar su permanencia contra quienes sí lo ven.
 */
@Schema({
  collection: 'milestone_awards',
  timestamps: { createdAt: true, updatedAt: false },
})
export class MilestoneAward {
  @Prop({ required: true, index: true })
  eventId!: string;

  @Prop({ required: true })
  milestoneId!: string;

  @Prop({ type: String, required: true })
  type!: MilestoneType;

  @Prop({ required: true })
  threshold!: number;

  @Prop({ required: true })
  attendeeId!: string;

  // UIDs (pestañas/dispositivos) a los que se envió la felicitación privada
  @Prop({ type: [String], default: [] })
  uids!: string[];

  // Nombre tal como se mostró ("Dr(a). Ana")
  @Prop()
  name?: string;

  // Valor alcanzado (minutos, encuestas, posición o saludos)
  @Prop()
  value?: number;

  @Prop({ default: false })
  holdout!: boolean;

  @Prop({ default: false })
  privateSent!: boolean;

  // Cuándo salió en una felicitación pública (si salió)
  @Prop()
  publicAt?: Date;

  createdAt?: Date;
}

export const MilestoneAwardSchema =
  SchemaFactory.createForClass(MilestoneAward);
// Un logro por asistente y hito
MilestoneAwardSchema.index(
  { eventId: 1, milestoneId: 1, attendeeId: 1 },
  { unique: true },
);
