import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type PollDocument = Poll & Document;

export enum PollStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  CLOSED = 'closed',
}

export enum QuestionType {
  SINGLE_CHOICE = 'single_choice',
  MULTIPLE_CHOICE = 'multiple_choice',
}

@Schema({ _id: false })
export class PollOption {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  text: string;

  @Prop({ default: 0 })
  votes: number;
}

export const PollOptionSchema = SchemaFactory.createForClass(PollOption);

@Schema({ _id: false })
export class PollQuestion {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true, enum: QuestionType })
  type: QuestionType;

  @Prop({ type: [PollOptionSchema], required: true })
  options: PollOption[];

  @Prop({ default: false })
  required: boolean;
}

export const PollQuestionSchema = SchemaFactory.createForClass(PollQuestion);

@Schema({ _id: false })
export class PollResponse {
  @Prop({ required: true }) // OrgAttendee ID (identificador persistente del usuario)
  orgAttendeeId: string;

  @Prop({ required: true })
  questionId: string;

  @Prop({ type: [String], required: true })
  selectedOptions: string[]; // IDs de las opciones seleccionadas

  @Prop({ default: Date.now })
  respondedAt: Date;
}

export const PollResponseSchema = SchemaFactory.createForClass(PollResponse);

@Schema({ timestamps: true })
export class Poll {
  @Prop({ required: true })
  title: string;

  @Prop()
  description: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Event', required: true })
  eventId: MongooseSchema.Types.ObjectId;

  @Prop({ type: [PollQuestionSchema], required: true })
  questions: PollQuestion[];

  @Prop({
    type: String,
    enum: PollStatus,
    default: PollStatus.DRAFT,
  })
  status: PollStatus;

  @Prop({ default: false })
  showStatistics: boolean; // Si se muestran stats en tiempo real

  @Prop({ type: [PollResponseSchema], default: [] })
  responses: PollResponse[];

  @Prop()
  publishedAt?: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ required: true })
  createdBy: string; // userId del admin que creó la encuesta

  @Prop({ default: 0 })
  totalResponses: number; // Cantidad de usuarios únicos que respondieron
}

export const PollSchema = SchemaFactory.createForClass(Poll);

// Índices para mejorar el rendimiento
PollSchema.index({ eventId: 1, status: 1 });
PollSchema.index({ eventId: 1, createdAt: -1 });
