import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MediaItemDocument = MediaItem & Document;

@Schema({ timestamps: true })
export class MediaItem {
  @Prop({ required: true, index: true })
  eventSlug: string;

  @Prop({ required: true })
  name: string;

  @Prop({ enum: ['image', 'gif', 'video', 'audio'], required: true })
  type: 'image' | 'gif' | 'video' | 'audio';

  @Prop({ required: true })
  url: string;

  @Prop()
  thumbnailUrl?: string;

  @Prop()
  description?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  duration?: number;

  @Prop({ required: true })
  fileSize: number;

  @Prop({ required: true })
  mimeType: string;

  @Prop()
  uploadedBy?: string;

  // Default configuration for this media item
  @Prop({ enum: ['overlay', 'full'], default: 'full' })
  defaultMode: 'overlay' | 'full';

  @Prop({ default: false })
  defaultLoop: boolean;

  @Prop({ default: true })
  defaultMuted: boolean;

  @Prop({ enum: ['cover', 'contain'], default: 'cover' })
  defaultFit: 'cover' | 'contain';

  @Prop({ min: 0, max: 1, default: 1 })
  defaultOpacity: number;
}

export const MediaItemSchema = SchemaFactory.createForClass(MediaItem);

MediaItemSchema.index({ eventSlug: 1 });
MediaItemSchema.index({ eventSlug: 1, name: 1 });
