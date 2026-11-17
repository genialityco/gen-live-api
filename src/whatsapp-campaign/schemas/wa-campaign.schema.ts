import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { WA_AUDIENCES, type WaAudience } from '../wa-audience';

export type WaCampaignStatus = 'draft' | 'sending' | 'completed' | 'failed' | 'cancelled';

@Schema({ _id: false })
export class WaCampaignStats {
  @Prop({ default: 0 }) total: number;
  @Prop({ default: 0 }) pending: number;
  @Prop({ default: 0 }) sent: number;
  @Prop({ default: 0 }) delivered: number;
  @Prop({ default: 0 }) read: number;
  @Prop({ default: 0 }) failed: number;
  @Prop({ default: 0 }) optedOut: number;
  @Prop({ default: 0 }) clicked: number;
  @Prop({ default: 0 }) totalClicks: number;
}

@Schema({ _id: false })
export class WaUtmParam {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) value: string;
}

/**
 * Envío automático cuando el evento pasa a diferido (grabación disponible).
 * La campaña queda en `draft` hasta que se dispara; `firedAt` evita que se
 * envíe dos veces.
 */
@Schema({ _id: false })
export class WaAutoSend {
  @Prop({ required: true, enum: ['on_replay'], default: 'on_replay' })
  trigger: 'on_replay';

  /** Minutos a esperar desde que se detecta el evento en diferido */
  @Prop({ required: true, default: 0 }) delayMinutes: number;

  /** Hora de envío, fijada al detectar el evento en diferido */
  @Prop({ type: Date, default: null }) dueAt: Date | null;

  @Prop({ type: Date, default: null }) firedAt: Date | null;

  @Prop({ type: String, default: null }) lastError: string | null;
}

@Schema({ timestamps: true })
export class WaCampaign {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'WaTemplate', required: true })
  templateId: Types.ObjectId;

  /** Snapshot del template al momento del envío */
  @Prop({ type: Object, default: null })
  templateSnapshot: {
    name: string;
    language: string;
    components: any[];
    variableMappings: Record<string, string>;
  } | null;

  @Prop({ type: [WaUtmParam], default: null })
  utmParams: WaUtmParam[] | null;

  /** A quién se envía. Las campañas anteriores no lo tienen: org_attendees. */
  @Prop({ type: String, enum: WA_AUDIENCES, default: 'org_attendees' })
  audience: WaAudience;

  @Prop({ type: WaAutoSend, default: null })
  autoSend: WaAutoSend | null;

  @Prop({
    required: true,
    enum: ['draft', 'sending', 'completed', 'failed', 'cancelled'],
    default: 'draft',
  })
  status: WaCampaignStatus;

  @Prop({ type: WaCampaignStats, default: () => ({}) })
  stats: WaCampaignStats;

  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) completedAt: Date | null;

  @Prop({ required: true })
  createdBy: string;
}

export type WaCampaignDocument = HydratedDocument<WaCampaign>;
export const WaCampaignSchema = SchemaFactory.createForClass(WaCampaign);

WaCampaignSchema.index({ orgId: 1, eventId: 1 });
WaCampaignSchema.index({ status: 1 });
