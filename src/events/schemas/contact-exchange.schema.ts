import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ContactExchangeDocument = HydratedDocument<ContactExchange>;

/** Aceptación de una de las dos personas del par */
export type ContactShare = { at: Date };

/**
 * Intercambio de contacto entre dos colegas de una organización. Nace cuando
 * uno devuelve el saludo del otro (saludo entre colegas) y los datos solo se
 * ven cuando ambos aceptan compartirlos (doble consentimiento). Es uno por
 * par y organización: si vuelven a saludarse en otro evento, se suma el
 * evento a `events` en vez de crear otro.
 *
 * `a` y `b` son attendeeIds (OrgAttendee) ordenados: a < b.
 */
@Schema({ collection: 'contact_exchanges', timestamps: true })
export class ContactExchange {
  @Prop({ required: true })
  orgId!: string;

  @Prop({ required: true })
  a!: string;

  @Prop({ required: true })
  b!: string;

  // Eventos donde se saludaron (el primero, el que lo originó)
  @Prop({ type: [String], default: [] })
  events!: string[];

  // Grupo de manada del último saludo ("Endocrinología", "Medellín"…)
  @Prop()
  groupLabel?: string;

  // Aceptaciones: con las dos (y sin bloqueo) el contacto es mutuo
  @Prop({ type: Object, default: null })
  aShare!: ContactShare | null;

  @Prop({ type: Object, default: null })
  bShare!: ContactShare | null;

  // «Ahora no»: se oculta de los pendientes de esa persona
  @Prop({ type: Date, default: null })
  aDismissedAt!: Date | null;

  @Prop({ type: Date, default: null })
  bDismissedAt!: Date | null;

  // Quien bloqueó (el par deja de verse para ambos)
  @Prop({ type: String, default: null })
  blockedBy!: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ContactExchangeSchema =
  SchemaFactory.createForClass(ContactExchange);
ContactExchangeSchema.index({ orgId: 1, a: 1, b: 1 }, { unique: true });
ContactExchangeSchema.index({ orgId: 1, a: 1 });
ContactExchangeSchema.index({ orgId: 1, b: 1 });
