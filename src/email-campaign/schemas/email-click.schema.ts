import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

const BOT_UA_PATTERNS = [
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
  'yandexbot', 'sogou', 'exabot', 'facebot', 'ia_archiver',
  'safelinks', 'scanmail', 'proofpoint', 'barracuda', 'mimecast',
  'postmaster', 'mailscanner', 'spamassassin', 'symantec',
  'headlesschrome', 'phantomjs', 'selenium', 'python-requests',
  'java/', 'curl/', 'wget/', 'libwww',
];

export function detectBot(userAgent: string): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((p) => ua.includes(p));
}

@Schema({ timestamps: true })
export class EmailClick {
  @Prop({ type: Types.ObjectId, ref: 'EmailCampaign', required: true })
  campaignId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'EmailDelivery', required: true })
  deliveryId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'OrgAttendee', required: true })
  attendeeId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Map, of: String, default: {} })
  utms: Map<string, string>;

  @Prop({ default: '' })
  userAgent: string;

  @Prop({ default: '' })
  ip: string;

  @Prop({ default: false })
  isBot: boolean;

  @Prop({ required: true })
  clickedAt: Date;

  @Prop({ type: Date, default: null })
  arrivedAt: Date | null;
}

export type EmailClickDocument = HydratedDocument<EmailClick>;
export const EmailClickSchema = SchemaFactory.createForClass(EmailClick);

EmailClickSchema.index({ campaignId: 1, isBot: 1 });
EmailClickSchema.index({ deliveryId: 1 });
