import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class EventUser extends Document {
  @Prop({ required: true })
  eventId: string; // ID del evento

  @Prop({ type: Types.ObjectId, ref: 'OrgAttendee', required: true })
  attendeeId: Types.ObjectId; // Referencia al OrgAttendee

  @Prop()
  firebaseUID?: string; // UID de Firebase para autenticación anónima (opcional)

  @Prop()
  lastLoginAt?: Date; // Último acceso del usuario

  @Prop({ default: 'registered' })
  status: 'registered' | 'attended' | 'cancelled'; // Estado del usuario en el evento

  @Prop({ default: () => new Date() })
  registeredAt: Date; // Fecha de inscripción al evento

  @Prop()
  attendedAt?: Date; // Fecha de asistencia al evento en vivo

  @Prop({ default: false })
  checkedIn: boolean; // Si se marcó como presente en el evento

  @Prop()
  checkedInAt?: Date; // Fecha de check-in

  @Prop({ type: Object })
  additionalData?: Record<string, any>; // Datos adicionales específicos del evento
}

export const EventUserSchema = SchemaFactory.createForClass(EventUser);

// Índices optimizados
EventUserSchema.index({ eventId: 1, attendeeId: 1 }, { unique: true }); // Un attendee solo puede registrarse una vez por evento
EventUserSchema.index({ eventId: 1, firebaseUID: 1 }); // Buscar por evento y Firebase UID
EventUserSchema.index({ attendeeId: 1 }); // Buscar todos los eventos de un attendee
EventUserSchema.index({ eventId: 1, status: 1 }); // Filtrar por estado en un evento
