import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EmailTemplateType = 'WELCOME';

@Schema({ timestamps: true })
export class EventEmailTemplate {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', default: null })
  eventId?: Types.ObjectId; // null = org-level default

  @Prop({ required: true, enum: ['WELCOME'] })
  type: EmailTemplateType;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  subject: string; // supports {{variables}}

  @Prop({ required: true })
  body: string; // HTML with {{variables}}

  @Prop({ default: true })
  enabled: boolean;
}

export type EventEmailTemplateDocument =
  HydratedDocument<EventEmailTemplate>;
export const EventEmailTemplateSchema =
  SchemaFactory.createForClass(EventEmailTemplate);

// One template per type per scope (org-level or event-level)
EventEmailTemplateSchema.index(
  { orgId: 1, eventId: 1, type: 1 },
  { unique: true },
);
