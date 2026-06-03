import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailStatus = 'valid' | 'bounced' | 'complained';

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

  @Prop({ type: String, default: null })
  phone: string | null; // Formato internacional sin +, ej: 521234567890

  @Prop({
    type: String,
    enum: ['valid', 'invalid', 'opted_out'],
    default: 'valid',
  })
  phoneStatus: 'valid' | 'invalid' | 'opted_out';

  // ─── Campos de estado de email (actualizados por webhooks de AWS SES) ───────

  @Prop({
    type: String,
    enum: ['valid', 'bounced', 'complained'],
    default: 'valid',
  })
  emailStatus: EmailStatus;

  // 'Permanent' = hard bounce (dirección inválida), 'Transient' = soft bounce (buzón lleno, etc.)
  @Prop({ type: String, default: null })
  emailBounceType: 'Permanent' | 'Transient' | null;

  @Prop({ type: Date, default: null })
  emailSuppressedAt: Date | null;

  @Prop({ type: String, default: null })
  emailSuppressReason: string | null;
}

export const OrgAttendeeSchema = SchemaFactory.createForClass(OrgAttendee);

// Índice único por organización y email
OrgAttendeeSchema.index({ organizationId: 1, email: 1 }, { unique: true });
OrgAttendeeSchema.index({ organizationId: 1, phone: 1 }, { sparse: true });
OrgAttendeeSchema.index({ emailStatus: 1 });
