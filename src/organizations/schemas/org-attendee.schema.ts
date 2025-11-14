import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class OrgAttendee extends Document {
  @Prop({ required: true })
  organizationId: string; // ID de la organización

  @Prop({ required: true })
  email: string; // Email del asistente (campo principal de identificación)

  @Prop({ required: true })
  name: string; // Nombre del asistente (del formulario de registro)

  @Prop({ type: Object })
  registrationData?: Record<string, any>; // Datos completos del formulario de registro

  @Prop()
  registeredAt?: Date; // Fecha de registro inicial

  @Prop({ type: [String], default: [] })
  eventIds: string[]; // IDs de eventos a los que se ha registrado/inscrito (no asistencia en vivo)
}

export const OrgAttendeeSchema = SchemaFactory.createForClass(OrgAttendee);

// Índice único por organización y email
OrgAttendeeSchema.index({ organizationId: 1, email: 1 }, { unique: true });
