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

  @Prop({
    enum: ['upcoming', 'live', 'ended', 'replay'],
    default: 'upcoming',
  })
  status: string;

  @Prop({ type: Object })
  branding?: EventBrandingConfig;

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
