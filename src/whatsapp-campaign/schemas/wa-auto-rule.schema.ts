import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { WA_AUDIENCES, type WaAudience } from '../wa-audience';
import { WaUtmParam } from './wa-campaign.schema';

/**
 * Regla de campaña automática de una organización.
 *
 * Mientras esté activa, cada evento de la organización que empiece desde
 * `appliesFrom` recibe una campaña programada con esta configuración, que se
 * envía sola cuando el evento pasa a diferido (ver WaAutoSendService). Así no
 * hay que crear la misma campaña a mano en cada evento.
 */
@Schema({ timestamps: true })
export class WaAutoRule {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  /** Nombre que tendrá la campaña creada en cada evento */
  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'WaTemplate', required: true })
  templateId: Types.ObjectId;

  @Prop({ type: String, enum: WA_AUDIENCES, default: 'event_no_show' })
  audience: WaAudience;

  /** Minutos a esperar desde que el evento pasa a diferido */
  @Prop({ required: true, default: 0 })
  delayMinutes: number;

  @Prop({ type: [WaUtmParam], default: null })
  utmParams: WaUtmParam[] | null;

  /** Solo aplica a eventos que empiezan desde esta fecha */
  @Prop({ type: Date, required: true })
  appliesFrom: Date;

  @Prop({ default: true })
  enabled: boolean;

  @Prop({ required: true })
  createdBy: string;
}

export type WaAutoRuleDocument = HydratedDocument<WaAutoRule>;
export const WaAutoRuleSchema = SchemaFactory.createForClass(WaAutoRule);

WaAutoRuleSchema.index({ orgId: 1 });
WaAutoRuleSchema.index({ enabled: 1 });
