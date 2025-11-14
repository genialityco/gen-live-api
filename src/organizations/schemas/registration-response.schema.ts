import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true })
export class RegistrationResponse {
  @Prop({ required: true }) orgId: string;
  @Prop() eventId?: string;
  @Prop({ required: true }) uid: string; // Firebase UID del usuario
  @Prop({ type: Object, required: true }) responses: Record<string, any>;
}

export type RegistrationResponseDocument =
  HydratedDocument<RegistrationResponse>;
export const RegistrationResponseSchema =
  SchemaFactory.createForClass(RegistrationResponse);
