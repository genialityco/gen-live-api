import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * EventMetrics: Métricas simplificadas por evento
 * Solo rastrea 3 valores:
 * 1. Espectadores concurrentes en este momento
 * 2. Pico máximo de concurrentes durante el live
 * 3. Total de usuarios únicos que estuvieron durante el live
 */
@Schema({ timestamps: true })
export class EventMetrics extends Document {
  @Prop({ required: true, unique: true, index: true })
  eventId: string;

  // Espectadores concurrentes ahora (últimos 60s)
  @Prop({ default: 0 })
  currentConcurrentViewers: number;

  // Pico máximo de concurrentes alcanzado durante el live
  @Prop({ default: 0 })
  peakConcurrentViewers: number;

  // Total de usuarios únicos que estuvieron durante el evento live
  // (se cuenta una sola vez por EventUser, sin importar cuántos dispositivos use)
  @Prop({ default: 0 })
  totalUniqueViewers: number;

  // Timestamp de la última actualización de concurrentes
  @Prop({ default: () => new Date() })
  lastUpdate: Date;
}

export const EventMetricsSchema = SchemaFactory.createForClass(EventMetrics);

// Índice para búsquedas rápidas
EventMetricsSchema.index({ eventId: 1 }, { unique: true });
