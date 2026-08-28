import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class EventUser extends Document {
  @Prop({ required: true })
  eventId: string; // ID del evento

  // type debe ser MongooseSchema.Types.ObjectId (no Types.ObjectId): con
  // Types.ObjectId, SchemaFactory.createForClass registra este path como
  // Mixed en vez de ObjectId, por lo que findOne({attendeeId: "<string>"})
  // nunca hace auto-cast y no matchea nada aunque el documento exista.
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OrgAttendee',
    required: true,
  })
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

  // ─── Certificado de asistencia (backend externo de certificados) ────────
  @Prop()
  certificateAttendeeId?: string; // _id del Attendee creado en backend-gen

  @Prop()
  certificateMemberId?: string; // _id del Member creado en backend-gen

  @Prop()
  certificateSyncedAt?: Date;

  @Prop()
  certificateSyncError?: string;
}

export const EventUserSchema = SchemaFactory.createForClass(EventUser);

// Índices optimizados
EventUserSchema.index({ eventId: 1, attendeeId: 1 }, { unique: true }); // Un attendee solo puede registrarse una vez por evento
EventUserSchema.index({ eventId: 1, firebaseUID: 1 }); // Buscar por evento y Firebase UID
EventUserSchema.index({ attendeeId: 1 }); // Buscar todos los eventos de un attendee
EventUserSchema.index({ eventId: 1, status: 1 }); // Filtrar por estado en un evento
