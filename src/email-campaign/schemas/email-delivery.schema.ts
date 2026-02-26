import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DeliveryStatus = 'pending' | 'sent' | 'rejected' | 'failed';

@Schema({ timestamps: true })
export class EmailDelivery {
  @Prop({ type: Types.ObjectId, ref: 'EmailCampaign', required: true })
  campaignId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'OrgAttendee', required: true })
  attendeeId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'EventUser', default: null })
  eventUserId: Types.ObjectId | null;

  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    enum: ['pending', 'sent', 'rejected', 'failed'],
    default: 'pending',
  })
  status: DeliveryStatus;

  @Prop({ type: String, default: null })
  sesMessageId: string | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;
}

export type EmailDeliveryDocument = HydratedDocument<EmailDelivery>;
export const EmailDeliverySchema = SchemaFactory.createForClass(EmailDelivery);

EmailDeliverySchema.index({ campaignId: 1 });
EmailDeliverySchema.index({ campaignId: 1, status: 1 });
EmailDeliverySchema.index({ sesMessageId: 1 }, { sparse: true });
