import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// Reutilizar interfaces de branding de Organization
export interface BrandingColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  text?: string;
}

export interface BrandingHeader {
  enabled?: boolean;
  backgroundImageUrl?: string; // Imagen de fondo desktop
  backgroundImageMobileUrl?: string; // Imagen de fondo mobile
}

export interface BrandingFooter {
  enabled?: boolean;
  backgroundImageUrl?: string; // Imagen de fondo desktop
  backgroundImageMobileUrl?: string; // Imagen de fondo mobile
}

export interface EventBrandingConfig {
  // Colores personalizados del evento
  colors?: BrandingColors;

  // Header personalizado del evento
  header?: BrandingHeader;

  // Footer personalizado del evento
  footer?: BrandingFooter;

  // Imagen de portada del evento
  coverImageUrl?: string;
  coverImageMobileUrl?: string;
}

export interface EventCertificatesConfig {
  enabled: boolean;
  // IDs del Event/Organization equivalentes en el backend externo de
  // certificados (backend-gen). Se auto-provisionan la primera vez que se
  // activa el toggle o se registra el primer attendee.
  certOrganizationId?: string;
  certEventId?: string;
}

export type HerdPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** Apariencia y comportamiento de un tipo de mensaje de manada */
export interface HerdMessageConfig {
  enabled?: boolean;
  // Variables: {nombre}, {cantidad}, {grupo}, {total}
  template?: string;
  position?: HerdPosition;
  durationSec?: number;
  label?: string; // etiqueta corta opcional del banner
  // Apariencia del banner (mismas plantillas que los anuncios del estudio, ver
  // AnnouncementStyle en el web); la colocación sale de `position`
  style?: {
    template?: string;
    mode?: string;
    size?: string;
    animation?: string;
    font?: string;
    bgColor?: string;
    textColor?: string;
    accentColor?: string;
  };
}

/**
 * Anuncios de "manada" sobre el video del asistente: agrupa a los conectados
 * por un campo del formulario de registro (p. ej. especialidad o sociedad) y
 * avisa en tiempo real cuántos de cada grupo hay ("contigo ya son 34
 * endocrinólogos conectados"). El mensaje privado lo ve solo quien llega; el
 * público, todos.
 */
export interface EventHerdConfig {
  enabled: boolean;
  fieldId?: string; // campo del formulario de la org que define la manada
  // Nombre a mostrar por opción (plural: "endocrinólogos"); si falta, la etiqueta de la opción
  groupLabels?: Array<{ value: string; label: string }>;
  accentColor?: string;
  privateMessage?: HerdMessageConfig;
  publicMessage?: HerdMessageConfig & {
    minIntervalSec?: number; // separación mínima entre anuncios públicos
    milestoneEvery?: number; // 1 = cada llegada; 10 = al llegar a 10, 20, 30...
  };
}

@Schema({ timestamps: true })
export class Event {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  orgId: Types.ObjectId;

  @Prop({ required: true })
  slug: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({
    type: {
      startsAt: { type: Date },
      endsAt: { type: Date },
    },
  })
  schedule?: {
    startsAt?: Date;
    endsAt?: Date;
  };

  @Prop({
    type: {
      url: { type: String },
      provider: { type: String },
    },
  })
  stream?: {
    url?: string;
    provider?: string;
  };

  // Lista de proveedores de video configurados para el evento (vimeo, bunny,
  // cloudflare, mux, etc.). No reemplaza a `stream` (que sigue siendo el
  // usado por el resto del código); es un campo nuevo y aditivo.
  @Prop({
    type: [
      {
        provider: { type: String },
        url: { type: String },
        meta: { type: Object },
      },
    ],
    default: [],
  })
  streams?: Array<{
    provider?: string;
    url?: string;
    meta?: Record<string, any>;
  }>;

  @Prop({ type: Date })
  endedAt?: Date;

  @Prop({
    enum: ['upcoming', 'live', 'ended', 'replay'],
    default: 'upcoming',
  })
  status: string;

  @Prop({ type: Object })
  branding?: EventBrandingConfig;

  @Prop({ type: Object })
  certificatesConfig?: EventCertificatesConfig;

  @Prop({ type: Object })
  herdConfig?: EventHerdConfig;

  @Prop({ default: false })
  hidden?: boolean;

  // Campo virtual para compatibilidad con frontend
  get startDate(): Date | undefined {
    return this.schedule?.startsAt;
  }
}

export type EventDocument = HydratedDocument<Event>;
export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ orgId: 1, slug: 1 }, { unique: true });

// Configurar para incluir campos virtuales en JSON
EventSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    // Añadir startDate como campo directo para compatibilidad
    if (ret.schedule?.startsAt) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (ret as any).startDate = ret.schedule.startsAt;
    }
    return ret;
  },
});
