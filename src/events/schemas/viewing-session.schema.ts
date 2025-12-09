import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ViewingSession: Rastrea sesiones individuales de visualización
 * Una misma persona (EventUser) puede tener múltiples sesiones (diferentes dispositivos/pestañas)
 * Pero para métricas únicas, se consolida por EventUser
 */
@Schema({ timestamps: true })
export class ViewingSession extends Document {
  @Prop({ required: true })
  eventId: string; // ID del evento

  @Prop({ type: Types.ObjectId, ref: 'EventUser', required: true })
  eventUserId: Types.ObjectId; // Referencia al EventUser (espectador único)

  @Prop({ required: true })
  firebaseUID: string; // UID de la sesión específica (dispositivo/pestaña)

  @Prop({ default: () => new Date() })
  startedAt: Date; // Cuándo inició esta sesión

  @Prop()
  endedAt?: Date; // Cuándo terminó (null = activa)

  @Prop({ default: () => new Date() })
  lastHeartbeat: Date; // Último heartbeat recibido

  @Prop({ default: 0 })
  totalWatchTimeSeconds: number; // Tiempo total visto en esta sesión (segundos)

  @Prop({ default: false })
  wasLiveDuringSession: boolean; // Si el evento estuvo EN_VIVO durante esta sesión

  @Prop({ default: 0 })
  liveWatchTimeSeconds: number; // Tiempo visto mientras el evento estaba EN_VIVO

  @Prop({ type: Object })
  metadata?: {
    userAgent?: string;
    platform?: string;
    browser?: string;
    connectionQuality?: string;
    [key: string]: any;
  };
}

export const ViewingSessionSchema =
  SchemaFactory.createForClass(ViewingSession);

// Índices para queries eficientes
ViewingSessionSchema.index({ eventId: 1, eventUserId: 1 }); // Todas las sesiones de un usuario en un evento
ViewingSessionSchema.index({ eventId: 1, lastHeartbeat: 1 }); // Sesiones activas por evento
ViewingSessionSchema.index({ eventId: 1, firebaseUID: 1, endedAt: 1 }); // Buscar sesión activa específica (CRÍTICO para performance)
ViewingSessionSchema.index({ eventId: 1, wasLiveDuringSession: 1 }); // Sesiones que vieron el live
ViewingSessionSchema.index({ endedAt: 1, lastHeartbeat: 1 }); // Para limpieza de sesiones obsoletas
