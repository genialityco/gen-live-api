import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LiveStreamConfigDocument = LiveStreamConfig & Document;

@Schema({ timestamps: true })
export class LiveStreamConfig {
  @Prop({ required: true, index: true })
  eventSlug: string;

  @Prop({ enum: ['rtmp', 'srt'], default: 'rtmp' })
  ingestProtocol: 'rtmp' | 'srt';

  // RTMP parts (guardas separado para armar URL)
  @Prop({ default: '' })
  rtmpServerUrl: string; // rtmp://vp-push-ed2.gvideo.co/in/

  @Prop({ default: '' })
  rtmpStreamKey: string; // 3836340?token...

  // SRT full ingest url si alguna vez lo vuelves a intentar
  @Prop({ default: '' })
  srtIngestUrl: string;

  // playback por evento
  @Prop({ default: '' })
  playbackHlsUrl: string;

  // opciones egress
  @Prop({ enum: ['grid', 'speaker'], default: 'grid' })
  layout: 'grid' | 'speaker';

  @Prop({ default: 20 })
  maxParticipants: number;

  // runtime
  @Prop({ default: 'idle' })
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'failed';

  @Prop({ default: '' })
  activeEgressId: string;

  @Prop({ default: '' })
  lastError: string;
}

export const LiveStreamConfigSchema =
  SchemaFactory.createForClass(LiveStreamConfig);

LiveStreamConfigSchema.index({ eventSlug: 1 }, { unique: true });
