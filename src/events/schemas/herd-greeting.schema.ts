import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HerdGreetingDocument = HydratedDocument<HerdGreeting>;

/**
 * Medición del saludo entre colegas (anuncios de manada). Un documento por
 * acción: impresión del anuncio individual, saludo enviado o devolución.
 */
@Schema({
  collection: 'herd_greetings',
  timestamps: { createdAt: true, updatedAt: false },
})
export class HerdGreeting {
  @Prop({ required: true, index: true })
  eventId!: string;

  @Prop({ required: true, enum: ['impression', 'greet', 'reply'] })
  kind!: 'impression' | 'greet' | 'reply';

  @Prop({ required: true })
  uid!: string;

  @Prop()
  attendeeId?: string;

  @Prop({ required: true })
  groupKey!: string;

  @Prop()
  groupLabel?: string;

  // impression/greet: qué anuncio individual lo originó
  @Prop()
  source?: string;

  // impression: ¿el anuncio traía el botón? (brazo del experimento)
  @Prop()
  hasButton?: boolean;

  // greet: conectados del grupo que lo recibieron (sin contar a quien saluda)
  @Prop()
  recipients?: number;

  // greet: id público del saludo · reply: saludo que se devuelve
  @Prop()
  greetingId?: string;

  // reply: a quién se devuelve
  @Prop()
  toUid?: string;

  createdAt?: Date;
}

export const HerdGreetingSchema = SchemaFactory.createForClass(HerdGreeting);
HerdGreetingSchema.index({ eventId: 1, kind: 1, uid: 1 });
// Una sola devolución por persona y saludo
HerdGreetingSchema.index(
  { eventId: 1, uid: 1, greetingId: 1 },
  { unique: true, partialFilterExpression: { kind: 'reply' } },
);
