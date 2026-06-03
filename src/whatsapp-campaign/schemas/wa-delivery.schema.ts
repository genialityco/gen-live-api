import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WaDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'opted_out';

@Schema({ timestamps: true })
export class WaDelivery {
  @Prop({ type: Types.ObjectId, ref: 'WaCampaign', required: true })
  campaignId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'OrgAttendee', required: true })
  attendeeId: Types.ObjectId;

  /** Número en formato internacional sin +, ej: 521234567890 */
  @Prop({ required: true })
  phone: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'opted_out'],
    default: 'pending',
  })
  status: WaDeliveryStatus;

  /** ID del mensaje retornado por Meta: wamid.xxx */
  @Prop({ type: String, default: null })
  waMessageId: string | null;

  /** Variables ya interpoladas para este destinatario */
  @Prop({ type: Object, default: {} })
  resolvedComponents: Record<string, string>;

  /** UTMs ya resueltos para este destinatario */
  @Prop({ type: Object, default: {} })
  resolvedUtms: Record<string, string>;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop({ type: Number, default: null })
  errorCode: number | null;

  @Prop({ type: Date, default: null }) sentAt: Date | null;
  @Prop({ type: Date, default: null }) deliveredAt: Date | null;
  @Prop({ type: Date, default: null }) readAt: Date | null;
  @Prop({ default: 0 }) clickCount: number;
  @Prop({ type: Date, default: null }) firstClickAt: Date | null;
}

export type WaDeliveryDocument = HydratedDocument<WaDelivery>;
export const WaDeliverySchema = SchemaFactory.createForClass(WaDelivery);

WaDeliverySchema.index({ campaignId: 1, status: 1 });
WaDeliverySchema.index({ waMessageId: 1 }, { sparse: true });
WaDeliverySchema.index({ attendeeId: 1 });
