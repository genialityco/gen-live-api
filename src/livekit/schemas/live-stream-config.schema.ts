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
  @Prop({
    enum: ['grid', 'speaker', 'presentation', 'pip', 'side_by_side'],
    default: 'speaker',
  })
  layout: 'grid' | 'speaker' | 'presentation' | 'pip' | 'side_by_side';

  @Prop({ default: 20 })
  maxParticipants: number;

  // runtime
  @Prop({ default: 'idle' })
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'failed';

  @Prop({ default: '' })
  activeEgressId: string;

  @Prop({ default: '' })
  lastError: string;

  @Prop({ enum: ['gcore', 'mux', 'vimeo'], default: 'gcore' })
  provider: 'gcore' | 'mux' | 'vimeo';

  @Prop({ default: '' })
  providerStreamId: string; // en mux: live_stream_id

  @Prop({ default: '' })
  providerPlaybackId: string; // en mux: playback_id

  @Prop({ default: false })
  showFrame: boolean;

  @Prop({ default: '' })
  frameUrl: string;

  // ===== MEDIA LAYER =====
  @Prop({ default: false })
  mediaEnabled: boolean;

  // Separación de capas: visual y audio pueden estar activos simultáneamente
  @Prop({ default: '' })
  activeVisualItemId: string; // Para video, imagen, gif

  @Prop({ default: '' })
  activeAudioItemId: string; // Para audio/música

  // Legacy: mantener para backward compatibility
  @Prop({ default: '' })
  activeMediaItemId: string;

  // ===== LEGACY FIELDS (backward compatibility) =====
  @Prop({ enum: ['image', 'gif', 'video', 'audio'], default: 'image' })
  mediaType: 'image' | 'gif' | 'video' | 'audio';

  @Prop({ default: '' })
  mediaUrl: string;

  // ===== OVERRIDE FIELDS (pueden sobrescribir defaults del MediaItem) =====
  // overlay: encima del video / full: reemplaza el video (como cortinilla)
  @Prop({ enum: ['overlay', 'full'] })
  mediaMode?: 'overlay' | 'full';

  @Prop()
  mediaLoop?: boolean;

  // autoplay en navegadores casi siempre requiere muted=true
  @Prop()
  mediaMuted?: boolean;

  @Prop({ enum: ['cover', 'contain'] })
  mediaFit?: 'cover' | 'contain';

  @Prop({ min: 0, max: 1 })
  mediaOpacity?: number;

  // ===== BACKGROUND =====
  @Prop({ default: '' })
  backgroundUrl: string; // URL de imagen/video/gif de fondo

  @Prop({ enum: ['image', 'gif', 'video'], default: 'image' })
  backgroundType: 'image' | 'gif' | 'video';

  @Prop({ default: '#000000' })
  backgroundColor: string; // Color de fondo (hex)
}

export const LiveStreamConfigSchema =
  SchemaFactory.createForClass(LiveStreamConfig);

LiveStreamConfigSchema.index({ eventSlug: 1 }, { unique: true });
