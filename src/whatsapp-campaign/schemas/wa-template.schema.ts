import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WaTemplateStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'paused' | 'disabled';
export type WaTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** Componente tal como lo espera/retorna la API de Meta */
export interface WaTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  buttons?: Array<{
    type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
    text: string;
    url?: string;
    phone_number?: string;
    example?: string[];
  }>;
  example?: { body_text?: string[][]; header_text?: string[] };
}

@Schema({ timestamps: true })
export class WaTemplate {
  /** Nombre del template en Meta: minúsculas, guiones bajos, sin espacios */
  @Prop({ required: true, unique: true })
  name: string;

  /** Nombre legible para mostrar en la UI */
  @Prop({ required: true })
  displayName: string;

  @Prop({ required: true, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], default: 'MARKETING' })
  category: WaTemplateCategory;

  @Prop({ required: true, default: 'es' })
  language: string;

  /** Componentes del template (header, body, footer, buttons) */
  @Prop({ type: [Object], required: true })
  components: WaTemplateComponent[];

  /**
   * Mapeo de variables del template a fuentes de datos.
   * Clave: "body.1", "body.2", "button.0.1"
   * Valor: "attendee.name" | "event.title" | "event.startDate" | "_tracking_url"
   */
  @Prop({ type: Object, default: {} })
  variableMappings: Record<string, string>;

  @Prop({
    required: true,
    enum: ['draft', 'pending_review', 'approved', 'rejected', 'paused', 'disabled'],
    default: 'draft',
  })
  status: WaTemplateStatus;

  /** ID del template en Meta (retornado al enviarlo a revisión) */
  @Prop({ type: String, default: null })
  metaTemplateId: string | null;

  @Prop({ type: String, default: null })
  rejectionReason: string | null;

  /** Template por defecto del sistema (no se puede borrar) */
  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ required: true })
  createdBy: string;
}

export type WaTemplateDocument = HydratedDocument<WaTemplate>;
export const WaTemplateSchema = SchemaFactory.createForClass(WaTemplate);

WaTemplateSchema.index({ status: 1 });
