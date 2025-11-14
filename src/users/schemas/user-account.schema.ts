import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true })
export class UserAccount {
  @Prop({ required: true, unique: true })
  firebaseUid: string;

  @Prop()
  email?: string;

  @Prop()
  displayName?: string; // Nombre para mostrar (reemplaza "name")

  @Prop()
  lastActiveAt?: Date; // Última actividad del usuario

  @Prop({ default: true })
  isActive: boolean; // Estado activo del usuario
}

export type UserAccountDocument = HydratedDocument<UserAccount>;
export const UserAccountSchema = SchemaFactory.createForClass(UserAccount);
