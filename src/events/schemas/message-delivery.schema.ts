import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MessageDeliveryDocument = HydratedDocument<MessageDelivery>;

export const DELIVERY_FEATURES = ['herd', 'milestone', 'greeting'] as const;
export const DELIVERY_CHANNELS = ['private', 'public'] as const;
export const DELIVERY_SOURCES = [
  // herd privado
  'welcome',
  'repeat',
  'manual',
  // herd público
  'growth',
  // saludo: saludo de un colega / devolución a mi saludo
  'received',
  'reply',
] as const;

export type DeliveryFeature = (typeof DELIVERY_FEATURES)[number];
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export type DeliverySource = (typeof DELIVERY_SOURCES)[number];

/**
 * Mensaje que efectivamente se le mostró a un asistente en la página del
 * evento (anuncio de manada privado o público, logro, saludo recibido).
 * Lo reporta el navegador al pintar el banner, así que "recibió" deja de
 * significar "era elegible" y pasa a significar "se le mostró".
 */
@Schema({
  collection: 'message_deliveries',
  timestamps: { createdAt: true, updatedAt: false },
})
export class MessageDelivery {
  @Prop({ required: true })
  eventId!: string;

  @Prop({ required: true })
  attendeeId!: string;

  @Prop({ required: true })
  uid!: string;

  @Prop({ type: String, required: true, enum: DELIVERY_FEATURES })
  feature!: DeliveryFeature;

  @Prop({ type: String, required: true, enum: DELIVERY_CHANNELS })
  channel!: DeliveryChannel;

  @Prop({ type: String, enum: DELIVERY_SOURCES })
  source?: DeliverySource;

  @Prop()
  groupKey?: string;

  // Identificador del mensaje (hito, saludo, marca del anuncio público): evita
  // contar dos veces el mismo mensaje en la misma pestaña
  @Prop()
  refId?: string;

  createdAt?: Date;
}

export const MessageDeliverySchema =
  SchemaFactory.createForClass(MessageDelivery);
MessageDeliverySchema.index({ eventId: 1, attendeeId: 1, createdAt: 1 });
MessageDeliverySchema.index(
  { eventId: 1, uid: 1, feature: 1, channel: 1, refId: 1 },
  { unique: true, partialFilterExpression: { refId: { $type: 'string' } } },
);
