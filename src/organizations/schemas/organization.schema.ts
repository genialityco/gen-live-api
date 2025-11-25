import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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

export interface BrandingConfig {
  // Logo
  logoUrl?: string;

  // Colores
  colors?: BrandingColors;

  // Header personalizado
  header?: BrandingHeader;

  // Footer personalizado
  footer?: BrandingFooter;
}

// Tipos de campos del formulario
export type FormFieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'number'
  | 'select'
  | 'checkbox'
  | 'textarea';

export type OptionsSource = 'manual' | 'countries' | 'states' | 'cities';

export interface FormFieldOption {
  label: string;
  value: string;
  // Para opciones dependientes (cascada)
  parentValue?: string; // Valor del campo padre que activa esta opción
}

export interface ConditionalRule {
  field: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains';
  value: any;
}

export interface ConditionalLogic {
  action: 'show' | 'hide' | 'enable' | 'disable' | 'require';
  conditions: ConditionalRule[];
  logic: 'and' | 'or'; // Cómo combinar múltiples condiciones
}

export interface FormField {
  id: string; // Identificador único del campo
  type: FormFieldType;
  label: string; // Etiqueta visible
  placeholder?: string;
  required: boolean;
  options?: FormFieldOption[]; // Para tipo 'select'

  // ✅ NUEVOS
  optionsSource?: OptionsSource; // si no está, asumimos 'manual'
  countryCode?: string; // ej: 'CO' para estados/ciudades

  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string; // Regex para validación personalizada
  };
  order: number; // Orden de aparición

  // Propiedades avanzadas
  helpText?: string; // Texto de ayuda que se muestra debajo del campo
  defaultValue?: any; // Valor por defecto
  hidden?: boolean; // Campo oculto
  autoCalculated?: boolean; // Se calcula automáticamente
  dependsOn?: string; // ID del campo padre (para cascada)
  conditionalLogic?: ConditionalLogic[]; // Reglas de visibilidad/habilitación
  isIdentifier?: boolean; // Campo usado para identificar registros únicos (evitar duplicados)
}

export interface RegistrationForm {
  enabled: boolean;
  title?: string;
  description?: string;
  fields: FormField[];
  submitButtonText?: string;
  successMessage?: string;
}

@Schema({ timestamps: true })
export class Organization {
  @Prop({ required: true }) name: string;
  @Prop({ required: true, unique: true }) domainSlug: string;
  @Prop() description?: string;
  @Prop({ type: Object })
  branding?: BrandingConfig;
  @Prop({ type: Object })
  registrationForm?: RegistrationForm;
  @Prop({ required: true }) ownerUid: string;
}
export type OrganizationDocument = HydratedDocument<Organization>;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
