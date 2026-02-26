import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CampaignStatus =
  | 'draft'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TargetAudience = 'event_users' | 'org_attendees' | 'both';

@Schema({ _id: false })
export class CampaignStats {
  @Prop({ default: 0 }) total: number;
  @Prop({ default: 0 }) pending: number;
  @Prop({ default: 0 }) sent: number;
  @Prop({ default: 0 }) rejected: number;
  @Prop({ default: 0 }) failed: number;
}

@Schema({ _id: false })
export class TemplateSnapshot {
  @Prop({ required: true }) subject: string;
  @Prop({ required: true }) body: string;
}

@Schema({ _id: false })
export class AudienceFilters {
  @Prop({ type: [String], default: undefined })
  eventUserStatus?: string[];
}

@Schema({ timestamps: true })
export class EmailCampaign {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'EventEmailTemplate', required: true })
  templateId: Types.ObjectId;

  @Prop({ type: TemplateSnapshot, default: null })
  templateSnapshot: TemplateSnapshot | null;

  @Prop({ required: true, enum: ['event_users', 'org_attendees', 'both'] })
  targetAudience: TargetAudience;

  @Prop({ type: AudienceFilters, default: null })
  audienceFilters: AudienceFilters | null;

  @Prop({
    required: true,
    enum: ['draft', 'sending', 'completed', 'failed', 'cancelled'],
    default: 'draft',
  })
  status: CampaignStatus;

  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) completedAt: Date | null;

  @Prop({ required: true })
  createdBy: string; // Firebase UID

  @Prop({ type: CampaignStats, default: () => ({}) })
  stats: CampaignStats;
}

export type EmailCampaignDocument = HydratedDocument<EmailCampaign>;
export const EmailCampaignSchema =
  SchemaFactory.createForClass(EmailCampaign);

EmailCampaignSchema.index({ orgId: 1, eventId: 1 });
EmailCampaignSchema.index({ status: 1 });
