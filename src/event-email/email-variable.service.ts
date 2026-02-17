import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  Organization,
  OrganizationDocument,
  FormField,
} from '../organizations/schemas/organization.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { Event, EventDocument } from '../events/schemas/event.schema';
import { EventUser } from '../events/schemas/event-user.schema';

export interface AvailableVariable {
  key: string;
  label: string;
  section: string;
  hasDisplayVariant?: boolean;
}

@Injectable()
export class EmailVariableService {
  private readonly frontendUrl: string;

  constructor(
    @InjectModel(Organization.name)
    private readonly orgModel: Model<OrganizationDocument>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    @InjectModel(EventUser.name)
    private readonly eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name)
    private readonly attendeeModel: Model<OrgAttendee>,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'https://app.gen.live';
  }

  /**
   * Returns the list of available variables for the template editor.
   */
  async getAvailableVariables(
    orgId: string,
    eventId?: string,
  ): Promise<AvailableVariable[]> {
    const variables: AvailableVariable[] = [];

    // Organization variables
    variables.push(
      { key: 'org.name', label: 'Nombre de la organización', section: 'Organización' },
      { key: 'org.description', label: 'Descripción', section: 'Organización' },
      { key: 'org.domainSlug', label: 'Slug del dominio', section: 'Organización' },
      { key: 'org.branding.logoUrl', label: 'URL del logo', section: 'Organización' },
      { key: 'org.registrationForm.title', label: 'Título del formulario', section: 'Organización' },
    );

    // Event variables
    if (eventId) {
      variables.push(
        { key: 'event.title', label: 'Título del evento', section: 'Evento' },
        { key: 'event.slug', label: 'Slug del evento', section: 'Evento' },
        { key: 'event.schedule.startsAt', label: 'Inicio (completo)', section: 'Evento' },
        { key: 'event.schedule.startsAt.date', label: 'Inicio (fecha)', section: 'Evento' },
        { key: 'event.schedule.startsAt.time', label: 'Inicio (hora)', section: 'Evento' },
        { key: 'event.schedule.endsAt', label: 'Fin (completo)', section: 'Evento' },
        { key: 'event.schedule.endsAt.date', label: 'Fin (fecha)', section: 'Evento' },
        { key: 'event.schedule.endsAt.time', label: 'Fin (hora)', section: 'Evento' },
        { key: 'event.schedule.startsAt.timezone', label: 'Zona horaria', section: 'Evento' },
        { key: 'event.branding.coverImageUrl', label: 'Imagen de portada', section: 'Evento' },
        { key: 'event.joinUrl', label: 'URL de ingreso', section: 'Evento' },
      );
    }

    // Attendee variables
    variables.push(
      { key: 'attendee.email', label: 'Email del asistente', section: 'Asistente' },
      { key: 'attendee.id', label: 'ID del asistente', section: 'Asistente' },
      { key: 'eventUser.status', label: 'Estado de registro', section: 'Asistente' },
      { key: 'eventUser.checkedIn', label: 'Check-in realizado', section: 'Asistente' },
    );

    // Dynamic form fields
    const org = await this.orgModel
      .findById(new Types.ObjectId(orgId))
      .lean<Organization>();

    const fields = org?.registrationForm?.fields ?? [];
    for (const field of fields) {
      if (field.hidden) continue;

      const hasDisplay =
        field.type === 'select' || field.type === 'checkbox';

      variables.push({
        key: `form.${field.id}`,
        label: field.label,
        section: 'Formulario',
        hasDisplayVariant: hasDisplay,
      });
    }

    return variables;
  }

  /**
   * Builds the full template context with real data for a specific attendee.
   */
  async buildContext(
    orgId: string,
    eventId: string,
    attendeeId: string,
    eventUserId?: string,
    origin?: string,
  ): Promise<Record<string, any>> {
    const [org, event, attendee] = await Promise.all([
      this.orgModel.findById(new Types.ObjectId(orgId)).lean<Organization>(),
      this.eventModel.findById(new Types.ObjectId(eventId)).lean(),
      this.attendeeModel
        .findById(new Types.ObjectId(attendeeId))
        .lean<OrgAttendee>(),
    ]);

    let eventUser: any = null;
    if (eventUserId) {
      eventUser = await this.eventUserModel
        .findById(new Types.ObjectId(eventUserId))
        .lean();
    } else if (attendee) {
      eventUser = await this.eventUserModel
        .findOne({
          eventId,
          attendeeId: new Types.ObjectId(attendeeId),
        })
        .lean();
    }

    const fields = org?.registrationForm?.fields ?? [];
    const registrationData = attendee?.registrationData ?? {};

    // Build form and formDisplay
    const form: Record<string, any> = {};
    const formDisplay: Record<string, string> = {};

    for (const field of fields) {
      const raw = registrationData[field.id];
      form[field.id] = raw ?? '';
      formDisplay[field.id] = this.resolveDisplayValue(field, raw);
    }

    return {
      org: {
        name: org?.name ?? '',
        description: org?.description ?? '',
        domainSlug: org?.domainSlug ?? '',
        branding: org?.branding ?? {},
        registrationForm: { title: org?.registrationForm?.title ?? '' },
      },
      event: {
        title: event?.title ?? '',
        slug: event?.slug ?? '',
        schedule: {
          startsAt: this.formatDate(event?.schedule?.startsAt),
          endsAt: this.formatDate(event?.schedule?.endsAt),
        },
        branding: event?.branding ?? {},
        joinUrl: this.buildJoinUrl(org, event, origin),
      },
      eventUser: {
        status: eventUser?.status ?? '',
        checkedIn: eventUser?.checkedIn ?? false,
      },
      attendee: {
        id: attendee?._id?.toString() ?? '',
        email: attendee?.email ?? '',
      },
      form,
      formDisplay,
    };
  }

  /**
   * Builds a sample context for preview, using placeholder values derived from form fields.
   */
  async buildSampleContext(
    orgId: string,
    eventId?: string,
  ): Promise<Record<string, any>> {
    const org = await this.orgModel
      .findById(new Types.ObjectId(orgId))
      .lean<Organization>();

    let event: any = null;
    if (eventId) {
      event = await this.eventModel
        .findById(new Types.ObjectId(eventId))
        .lean();
    }

    const fields = org?.registrationForm?.fields ?? [];
    const form: Record<string, any> = {};
    const formDisplay: Record<string, string> = {};

    for (const field of fields) {
      const sample = this.getSampleValue(field);
      form[field.id] = sample;
      formDisplay[field.id] = this.resolveDisplayValue(field, sample);
    }

    return {
      org: {
        name: org?.name ?? 'Mi Organización',
        description: org?.description ?? '',
        domainSlug: org?.domainSlug ?? 'mi-org',
        branding: org?.branding ?? {},
        registrationForm: { title: org?.registrationForm?.title ?? '' },
      },
      event: {
        title: event?.title ?? 'Mi Evento',
        slug: event?.slug ?? 'mi-evento',
        schedule: {
          startsAt: this.formatDate(event?.schedule?.startsAt ?? new Date()),
          endsAt: this.formatDate(event?.schedule?.endsAt),
        },
        branding: event?.branding ?? {},
        joinUrl: this.buildJoinUrl(org, event),
      },
      eventUser: {
        status: 'registered',
        checkedIn: false,
      },
      attendee: {
        id: '000000000000000000000000',
        email: 'ejemplo@mail.com',
      },
      form,
      formDisplay,
    };
  }

  /**
   * Centralized helper to build the event join URL.
   * Ready to accept tokens/uid in the future.
   */
  buildJoinUrl(
    org: Organization | null | undefined,
    event: any | null | undefined,
    origin?: string,
  ): string {
    if (!org?.domainSlug || !event?.slug) return '';
    const baseUrl = origin || this.frontendUrl;
    return `${baseUrl}/org/${org.domainSlug}/event/${event.slug}`;
  }

  /**
   * Formats a date into a structured object with full, date, time, and timezone parts.
   * Returns a string for simple {{variable}} usage, but the object properties
   * are accessible via {{variable.date}}, {{variable.time}}, etc.
   */
  private formatDate(value: any): any {
    const empty = { full: '', date: '', time: '', timezone: '', toString: () => '' };
    if (!value) return empty;
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return empty;

    const tz = 'America/Bogota';

    const datePart = d.toLocaleDateString('es-CO', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: tz,
    });

    const timePart = d.toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    });

    const full = `${datePart}, ${timePart} (Hora Colombia)`;

    return { full, date: datePart, time: timePart, timezone: 'Hora Colombia', toString: () => full };
  }

  private resolveDisplayValue(field: FormField, rawValue: any): string {
    if (rawValue === undefined || rawValue === null) return '';

    if (field.type === 'select' && field.options?.length) {
      const opt = field.options.find((o) => o.value === rawValue);
      return opt?.label ?? String(rawValue);
    }

    if (field.type === 'checkbox') {
      return rawValue ? 'Sí' : 'No';
    }

    return String(rawValue);
  }

  private getSampleValue(field: FormField): any {
    switch (field.type) {
      case 'text':
        return 'Juan';
      case 'email':
        return 'ejemplo@mail.com';
      case 'tel':
        return '+57 300 123 4567';
      case 'number':
        return 25;
      case 'textarea':
        return 'Texto de ejemplo';
      case 'select':
        return field.options?.[0]?.value ?? '';
      case 'checkbox':
        return true;
      default:
        return '';
    }
  }
}
