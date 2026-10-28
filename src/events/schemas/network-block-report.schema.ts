import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NetworkBlockCause =
  | 'video_blocked' // solo falla el servidor del video (bloqueo por categoría)
  | 'all_blocked' // falla también el sitio de control (inspección SSL general)
  | 'timeout'; // la red descarta la conexión sin responder

export type ProbeResult = 'ok' | 'blocked' | 'timeout';

/**
 * Bloqueo de red reportado por la página del asistente: su navegador no pudo
 * conectarse al servidor del video (firewall, proxy, inspección SSL…). Un
 * documento por asistente (uid), evento y servidor de video; si se repite se
 * actualiza. Guarda el prefijo de la IP (/24 o /48), no la IP completa.
 */
@Schema({ timestamps: true, collection: 'network_block_reports' })
export class NetworkBlockReport extends Document {
  @Prop({ required: true, index: true })
  eventId: string;

  @Prop({ required: true })
  uid: string; // Firebase UID de la sesión

  @Prop()
  attendeeId?: string;

  @Prop({ required: true })
  videoHost: string;

  @Prop()
  videoUrl?: string;

  @Prop({ required: true })
  cause: NetworkBlockCause;

  // Resultado por dominio probado (video, CDN, sitio de control)
  @Prop({ type: [{ host: String, result: String, ms: Number, _id: false }] })
  probes: Array<{ host: string; result: ProbeResult; ms: number }>;

  @Prop()
  userAgent?: string;

  @Prop()
  mobile?: boolean;

  @Prop()
  platform?: string;

  @Prop()
  connectionType?: string; // navigator.connection.effectiveType/type si existe

  @Prop()
  ipPrefix?: string; // ej. '190.25.12.0/24'

  @Prop()
  country?: string;

  @Prop()
  asn?: number;

  @Prop()
  asnOrg?: string;

  @Prop({ default: 1 })
  occurrences: number;

  @Prop({ default: false })
  recovered: boolean; // luego pudo conectarse (p. ej. cambió a datos móviles)

  @Prop()
  recoveredAt?: Date;

  @Prop({ default: () => new Date() })
  lastSeenAt: Date;
}

export const NetworkBlockReportSchema =
  SchemaFactory.createForClass(NetworkBlockReport);

NetworkBlockReportSchema.index(
  { eventId: 1, uid: 1, videoHost: 1 },
  { unique: true },
);
