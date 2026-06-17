/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { EventMetrics } from './schemas/event-metrics.schema';
import { Poll } from './schemas/poll.schema';
import {
  FormFieldType,
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { InjectModel as Inject } from '@nestjs/mongoose';
import { RtdbService } from '../rtdb/rtdb.service';
import { RtdbPresenceWatcherService } from '../rtdb/rtdb-presence-watcher.service';
import { RegisterToEventDto } from './dtos/register-to-event.dto';
import { UpdateEventBrandingDto } from './dtos/update-event-branding.dto';
import { ViewingMetricsService } from './viewing-metrics.service.v2';
import { LivekitEgressService } from '../livekit/livekit-egress.service';
import { LiveConfigService } from '../livekit/live-config.service';
import { EmailSendService } from '../event-email/email-send.service';
import { EventEmailTemplateService } from '../event-email/event-email-template.service';
import { EmailCampaignService } from '../email-campaign/email-campaign.service';

function normalizeByType(value: any, type: FormFieldType | undefined) {
  if (value === null || value === undefined) return value;

  switch (type) {
    case 'text':
    case 'email':
    case 'tel':
    case 'textarea':
    case 'select':
      return String(value).trim();

    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }

    case 'checkbox': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['true', '1', 'on', 'sí', 'si', 'yes'].includes(v)) return true;
        if (['false', '0', 'off', 'no'].includes(v)) return false;
      }
      return value;
    }

    default:
      return value;
  }
}

const DEFAULT_EMAIL_TEMPLATES = [
  {
    type: 'WELCOME' as const,
    name: 'Email de bienvenida',
    subject: '¡Bienvenido/a a {{event.title}}!',
    body: `<h2>¡Hola!</h2>

<p>Tu registro al evento <strong>{{event.title}}</strong> ha sido confirmado.</p>

<table cellpadding="0" cellspacing="0" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
  <tr>
    <td style="padding: 12px 16px; background-color: #f8f9fa; border-radius: 8px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px; width: 110px;">Fecha de inicio</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.startsAt.date}}, {{event.schedule.startsAt.time}}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px;">Fecha de fin</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.endsAt.date}}, {{event.schedule.endsAt.time}}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding: 4px 0; color: #adb5bd; font-size: 11px;">{{event.schedule.startsAt.timezone}}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<p>Puedes acceder al evento desde el siguiente enlace:</p>
<p><a href="{{event.joinUrl}}" style="display: inline-block; padding: 10px 24px; background-color: #4263eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Ir al evento</a></p>

<p>¡Te esperamos!</p>`,
  },
  {
    type: 'INVITATION' as const,
    name: 'Email de invitación',
    subject: 'Te invitamos a {{event.title}}',
    body: `<h2>¡Hola!</h2>

<p>Te invitamos a participar en nuestro próximo evento: <strong>{{event.title}}</strong>.</p>

<table cellpadding="0" cellspacing="0" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
  <tr>
    <td style="padding: 12px 16px; background-color: #f8f9fa; border-radius: 8px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px; width: 110px;">Fecha</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.startsAt.date}}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px;">Hora</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.startsAt.time}} ({{event.schedule.startsAt.timezone}})</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<p>Regístrate y accede al evento desde el siguiente enlace:</p>
<p><a href="{{event.joinUrlWithUtm}}" style="display: inline-block; padding: 10px 24px; background-color: #4263eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Ver evento</a></p>

<p>¡Esperamos contar con tu presencia!</p>`,
  },
  {
    type: 'REMINDER' as const,
    name: 'Email de recordatorio',
    subject: 'Recordatorio: {{event.title}} empieza pronto',
    body: `<h2>¡Hola!</h2>

<p>Te recordamos que el evento <strong>{{event.title}}</strong> al que estás registrado/a comienza pronto.</p>

<table cellpadding="0" cellspacing="0" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
  <tr>
    <td style="padding: 12px 16px; background-color: #f8f9fa; border-radius: 8px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px; width: 110px;">Fecha</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.startsAt.date}}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #868e96; font-size: 13px;">Hora</td>
          <td style="padding: 4px 0; font-size: 13px;">{{event.schedule.startsAt.time}} ({{event.schedule.startsAt.timezone}})</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<p>Accede al evento en el momento indicado desde este enlace:</p>
<p><a href="{{event.joinUrlWithUtm}}" style="display: inline-block; padding: 10px 24px; background-color: #4263eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Ir al evento</a></p>

<p>¡Hasta pronto!</p>`,
  },
];

@Injectable()
export class EventsService implements OnModuleInit {
  private logger = console;

  constructor(
    @InjectModel(Event.name) private model: Model<EventDocument>,
    @Inject(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name) private orgAttendeeModel: Model<OrgAttendee>,
    @InjectModel(ViewingSession.name) private viewingSessionModel: Model<ViewingSession>,
    @InjectModel(EventMetrics.name) private eventMetricsModel: Model<EventMetrics>,
    @InjectModel(Poll.name) private pollModel: Model<Poll>,
    private rtdb: RtdbService,
    private watcher: RtdbPresenceWatcherService,
    private metricsService: ViewingMetricsService,
    private livekitEgressService: LivekitEgressService,
    private liveConfigService: LiveConfigService,
    private emailSendService: EmailSendService,
    private emailTemplateService: EventEmailTemplateService,
    private emailCampaignService: EmailCampaignService,
  ) {
    // Configurar watcher con servicio de métricas para evitar dependencia circular
    this.watcher.setViewingMetricsService(this.metricsService);
  }

  /**
   * Inicializar watchers para eventos que ya están en live cuando el servidor inicia
   */
  async onModuleInit() {
    try {
      const liveEvents = await this.model.find({ status: 'live' }).lean();

      if (liveEvents.length === 0) {
        this.logger.log('✅ No live events found - no watchers to activate');
        return;
      }

      for (const event of liveEvents) {
        await this.watcher.watch(event._id.toString());
      }
    } catch (error) {
      this.logger.error('❌ Error activating presence watchers:', error);
    }
  }

  async create(dto: Partial<Event>) {
    return this.model.create(dto);
  }

  async findById(id: string) {
    const ev = await this.model.findById(id).lean();
    if (!ev) throw new NotFoundException('Event not found');
    return ev;
  }

  async bySlug(slug: string) {
    const ev = await this.model.findOne({ slug }).lean();
    if (!ev) throw new NotFoundException('Event not found by slug');
    return ev;
  }

  async listByOwnerUid(ownerUid: string) {
    const orgs = await this.orgModel.find({ ownerUid }, { _id: 1 }).lean();
    const orgIds = orgs.map((o) => o._id);
    return this.model
      .find({ orgId: { $in: orgIds } })
      .sort({ createdAt: -1 })
      .lean();
  }

  async getOwnerUidByEventId(eventId: string) {
    const ev = await this.model.findById(eventId, { orgId: 1 }).lean();
    if (!ev) throw new NotFoundException('Event not found');
    const org = await this.orgModel.findById(ev.orgId, { ownerUid: 1 }).lean();
    if (!org) throw new NotFoundException('Org not found');
    return org.ownerUid;
  }

  async setStatus(
    eventId: string,
    status: 'upcoming' | 'live' | 'ended' | 'replay',
  ) {
    const ev = await this.model
      .findByIdAndUpdate(eventId, { status }, { new: true })
      .lean();
    if (!ev) throw new NotFoundException('Event not found');
    await this.rtdb.setStatus(eventId, status);

    if (status === 'live') {
      // Inicializar métricas en RTDB cuando el evento pasa a live
      await this.metricsService.getEventMetrics(eventId);
      this.watcher.watch(eventId);
    } else if (status === 'ended' || status === 'replay') {
      this.watcher.unwatch(eventId);
    }

    if (status === 'ended') {
      await this.model.findByIdAndUpdate(
        eventId,
        { endedAt: new Date() },
        { new: true },
      );
      await this.rtdb.setNowCount(eventId, 0);
      // Calcular métricas finales cuando el evento termina
      await this.metricsService.calculateEventMetrics(eventId);
    }

    return { ok: true, eventId, status };
  }

  async updateEvent(eventId: string, updates: any) {
    // Convertir fechas string a Date si vienen en schedule
    if (updates.schedule) {
      const schedule: any = {};
      if (updates.schedule.startsAt) {
        schedule.startsAt = new Date(updates.schedule.startsAt);
      }
      if (updates.schedule.endsAt) {
        schedule.endsAt = new Date(updates.schedule.endsAt);
      }
      updates.schedule = schedule;
    }

    const ev = await this.model
      .findByIdAndUpdate(eventId, { $set: updates }, { new: true })
      .lean();
    if (!ev) throw new NotFoundException('Event not found');
    return ev;
  }

  async listByOrgId(orgId: string) {
    try {
      const objectId = new Types.ObjectId(orgId);
      return this.model
        .find({ orgId: objectId }, null, { sort: { createdAt: -1 } })
        .lean();
    } catch (error) {
      console.error('Error en listByOrgId:', error);
      throw error;
    }
  }

  /**
   * Próximo evento (el de `schedule.startsAt` más cercano en el futuro, no oculto)
   * para un conjunto de organizaciones, resuelto en una sola consulta.
   * Devuelve un mapa orgId(string) → datos mínimos del evento.
   */
  async nextUpcomingByOrgIds(
    orgIds: Types.ObjectId[],
  ): Promise<
    Record<
      string,
      {
        _id: Types.ObjectId;
        slug: string;
        title: string;
        status: string;
        startsAt: Date;
      }
    >
  > {
    if (!orgIds.length) return {};
    const now = new Date();
    const rows = await this.model.aggregate([
      {
        $match: {
          orgId: { $in: orgIds },
          hidden: { $ne: true },
          'schedule.startsAt': { $gte: now },
        },
      },
      { $sort: { 'schedule.startsAt': 1 } },
      {
        $group: {
          _id: '$orgId',
          eventId: { $first: '$_id' },
          slug: { $first: '$slug' },
          title: { $first: '$title' },
          status: { $first: '$status' },
          startsAt: { $first: '$schedule.startsAt' },
        },
      },
    ]);

    const map: Record<string, any> = {};
    for (const r of rows) {
      map[r._id.toString()] = {
        _id: r.eventId,
        slug: r.slug,
        title: r.title,
        status: r.status,
        startsAt: r.startsAt,
      };
    }
    return map;
  }

  async listByOrgIdPublic(orgId: string) {
    try {
      const objectId = new Types.ObjectId(orgId);
      return this.model
        .find({ orgId: objectId, hidden: { $ne: true } })
        .select(
          'slug title description status schedule stream branding createdAt',
        )
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      console.error('Error en listByOrgIdPublic:', error);
      throw error;
    }
  }

  async createForOrg(dto: {
    orgId: string;
    slug: string;
    title: string;
    schedule?: any;
    stream?: any;
  }) {
    // normaliza slug en backend también
    const clean = (s: string) => s.trim().toLowerCase();
    const event = await this.model.create({
      orgId: new this.model.db.base.Types.ObjectId(dto.orgId),
      slug: clean(dto.slug),
      title: dto.title.trim(),
      schedule: dto.schedule,
      stream: dto.stream,
      status: 'upcoming',
    });

    // Sembrar plantillas de email por defecto (fire-and-forget)
    const eventId = event._id.toString();
    Promise.all(
      DEFAULT_EMAIL_TEMPLATES.map((tpl) =>
        this.emailTemplateService.upsert({
          orgId: dto.orgId,
          eventId,
          type: tpl.type,
          name: tpl.name,
          subject: tpl.subject,
          body: tpl.body,
          enabled: true,
        }),
      ),
    ).catch((err) =>
      this.logger.error('Error seeding default email templates:', err?.message ?? err),
    );

    return event;
  }

  async updateStream(
    eventId: string,
    payload: { provider: 'vimeo' | 'mux'; url: string; meta?: any },
  ) {
    const ev = await this.model
      .findByIdAndUpdate(
        eventId,
        {
          stream: {
            provider: payload.provider,
            url: payload.url,
            meta: payload.meta,
          },
        },
        { new: true },
      )
      .lean();
    if (!ev) throw new NotFoundException('Event not found');
    return { ok: true, eventId, stream: ev.stream };
  }

  /**
   * Registra un usuario (attendee) a un evento
   * 1. Crea o actualiza el OrgAttendee
   * 2. Crea el EventUser vinculándolo al evento
   */
  async registerUserToEvent(eventId: string, dto: RegisterToEventDto, origin?: string) {
    // Verificar que el evento existe y obtener orgId
    const event = await this.model.findById(eventId, { orgId: 1 }).lean();
    if (!event) throw new NotFoundException('Event not found');

    const organizationId = event.orgId;

    // 1. Crear o actualizar OrgAttendee (guarda datos del formulario)
    const attendee = await this.orgAttendeeModel
      .findOneAndUpdate(
        { organizationId, email: dto.email },
        {
          organizationId,
          email: dto.email,
          registrationData: dto.formData, // Todos los campos del formulario
          metadata: dto.metadata,
          isActive: true,
          registeredAt: new Date(),
          $addToSet: { eventIds: eventId }, // Agregar eventId si no existe
        },
        { upsert: true, new: true },
      )
      .lean();

    // 2. Crear EventUser (solo inscripción al evento, sin duplicar datos)
    const attendeeObjectId = new Types.ObjectId(attendee._id.toString());

    // Preparar los datos del EventUser
    const eventUserData: any = {
      eventId,
      attendeeId: attendeeObjectId,
      status: 'registered',
      registeredAt: new Date(),
      checkedIn: false,
    };

    // Agregar Firebase UID si se proporciona
    if (dto.firebaseUID) {
      eventUserData.firebaseUID = dto.firebaseUID;
      eventUserData.lastLoginAt = new Date();
    }

    const eventUser = await this.eventUserModel
      .findOneAndUpdate(
        { eventId, attendeeId: attendeeObjectId },
        eventUserData,
        { upsert: true, new: true },
      )
      .populate('attendeeId')
      .lean();

    // Fire-and-forget: send welcome email without blocking registration
    this.emailSendService
      .sendWelcomeEmail({
        orgId: event.orgId.toString(),
        eventId,
        attendeeId: attendee._id.toString(),
        eventUserId: eventUser._id.toString(),
        email: dto.email,
        origin,
      })
      .catch((err) =>
        this.logger.error('Welcome email failed:', err?.message ?? err),
      );

    return { attendee, eventUser };
  }

  /**
   * Verifica si un usuario ya está registrado en un evento (por email)
   */
  async isUserRegisteredToEvent(
    eventId: string,
    email: string,
  ): Promise<{ isRegistered: boolean; orgAttendee?: any; eventUser?: any }> {
    // First find the OrgAttendee by email
    const event = await this.model.findById(eventId).lean();
    if (!event) return { isRegistered: false };

    const attendee = await this.orgAttendeeModel
      .findOne({
        organizationId: event.orgId,
        email,
      })
      .lean();

    if (!attendee) return { isRegistered: false };

    // Then check if there's an EventUser for this attendee
    const eventUser = await this.eventUserModel
      .findOne({ eventId, attendeeId: attendee._id })
      .lean();

    return {
      isRegistered: !!eventUser,
      orgAttendee: attendee,
      eventUser: eventUser || undefined,
    };
  }

  /**
   * Verifica si un usuario ya está registrado en un evento (por Firebase UID)
   */
  async isUserRegisteredByUID(
    eventId: string,
    firebaseUID: string,
  ): Promise<boolean> {
    const eventUser = await this.eventUserModel
      .findOne({ eventId, firebaseUID })
      .lean();

    return !!eventUser;
  }

  /**
   * Verifica registro en una organización usando campos identificadores
   * (sin necesidad de eventId)
   */
  async checkOrgRegistrationByIdentifiers(
    organizationId: string,
    identifierFields: Record<string, any>,
  ) {
    // --- Validar orgId ---
    let orgObjectId: Types.ObjectId;
    try {
      orgObjectId = new Types.ObjectId(organizationId);
    } catch {
      throw new BadRequestException('Invalid organizationId');
    }

    // --- Cargar organización y su registrationForm ---
    const org = await this.orgModel
      .findById(orgObjectId)
      .lean<Organization>()
      .exec();

    if (!org) {
      throw new BadRequestException('Organization not found');
    }

    const registrationForm = org.registrationForm;
    const fields = registrationForm?.fields ?? [];

    // Mapa: fieldId -> FormField
    const fieldConfigMap = new Map<
      string,
      { type: FormFieldType; isIdentifier: boolean }
    >();
    for (const f of fields) {
      if (f.isIdentifier) {
        fieldConfigMap.set(f.id, { type: f.type, isIdentifier: true });
      }
    }

    // --- Validar estructura básica y normalizar ---
    const identifierEntries = Object.entries(identifierFields);

    const normalizedEntries = identifierEntries.map(([fieldId, raw]) => {
      const cfg = fieldConfigMap.get(fieldId);

      if (!cfg) {
        // Opcional: podrías lanzar error si te mandan un identificador desconocido
        console.warn(
          `⚠️ Field "${fieldId}" no está marcado como isIdentifier en registrationForm`,
        );
      }

      if (raw === undefined || raw === null || raw === '') {
        throw new BadRequestException(`Missing or empty field: ${fieldId}`);
      }

      if (fieldId === 'email') {
        const v = String(raw).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          throw new BadRequestException(`Invalid email format: ${v}`);
        }
      }

      const norm = normalizeByType(raw, cfg?.type);
      return [fieldId, norm] as [string, any];
    });

    // --- Query completo con TODOS los identificadores ---
    const fullQuery: any = { organizationId: orgObjectId };
    normalizedEntries.forEach(([fieldId, value]) => {
      // Regla: si el id es "email" lo buscamos en root,
      // lo demás va en registrationData
      if (fieldId === 'email') {
        fullQuery.email = value;
      } else {
        fullQuery[`registrationData.${fieldId}`] = value;
      }
    });

    const orgAttendee = await this.orgAttendeeModel.findOne(fullQuery).lean();

    // ✅ Caso 1: todos los campos coinciden
    if (orgAttendee) {
      return {
        found: true,
        orgAttendee,
      };
    }

    // ===================== COINCIDENCIAS PARCIALES =====================
    if (normalizedEntries.length === 0) {
      return {
        found: false,
        reason: 'USER_NOT_FOUND',
        message: 'No user registered with this organization',
      };
    }

    // $or con TODOS los identificadores normalizados
    const orConditions = normalizedEntries.map(([fieldId, value]) => {
      if (fieldId === 'email') return { email: value };
      return { [`registrationData.${fieldId}`]: value };
    });

    const candidates = await this.orgAttendeeModel
      .find({
        organizationId: orgObjectId,
        $or: orConditions,
      })
      .lean();

    // ❌ Ningún registro coincide con ningún identificador
    if (!candidates || candidates.length === 0) {
      return {
        found: false,
        reason: 'USER_NOT_FOUND',
        message: 'No user registered with this organization',
      };
    }

    // Elegimos el candidato con MÁS coincidencias
    let bestCandidate: any = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      let score = 0;

      for (const [fieldId, value] of normalizedEntries) {
        const candidateVal =
          fieldId === 'email'
            ? candidate.email
            : candidate.registrationData?.[fieldId];

        if (candidateVal === value) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate || bestScore === 0) {
      return {
        found: false,
        reason: 'USER_NOT_FOUND',
        message: 'No user registered with this organization',
      };
    }

    // Campos que NO coinciden para el mejor candidato
    const mismatched: string[] = [];
    for (const [fieldId, value] of normalizedEntries) {
      const candidateVal =
        fieldId === 'email'
          ? bestCandidate.email
          : bestCandidate.registrationData?.[fieldId];

      if (candidateVal !== value) {
        mismatched.push(fieldId);
      }
    }

    return {
      found: false,
      reason: 'INVALID_FIELDS',
      message:
        mismatched.length > 0
          ? `Some fields do not match: ${mismatched.join(', ')}`
          : 'Some fields do not match our records',
      mismatched,
    };
  }

  /**
   * Verifica registro usando campos identificadores del formulario
   * Retorna: { isRegistered: boolean, orgAttendee?: OrgAttendee, eventUser?: EventUser }
   */
  async checkRegistrationByIdentifiers(
    eventId: string,
    identifierFields: Record<string, any>,
  ) {
    // 1. Obtener el evento
    const event = await this.model.findById(eventId).lean();
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // 2. Reutilizar la lógica de ORG para encontrar el OrgAttendee
    //    Nota: checkOrgRegistrationByIdentifiers espera organizationId como string
    const orgResult = await this.checkOrgRegistrationByIdentifiers(
      event.orgId.toString(),
      identifierFields,
    );

    // 🔹 No se encontró ningún OrgAttendee válido
    if (!orgResult || !orgResult.found || !orgResult.orgAttendee) {
      return {
        isRegistered: false,
        status: orgResult?.reason ?? 'USER_NOT_FOUND',
        message:
          orgResult?.message ?? 'No registration found for this organization',
        mismatched: orgResult?.mismatched ?? [],
      };
    }

    const orgAttendee = orgResult.orgAttendee;

    // 3. Verificar si ya existe EventUser para este evento
    const eventUser = await this.eventUserModel
      .findOne({ eventId, attendeeId: orgAttendee._id })
      .lean();

    if (!eventUser) {
      return {
        isRegistered: false,
        status: 'ORG_ONLY',
        orgAttendee,
        message:
          'User found in organization but not registered to this specific event',
      };
    }

    return {
      isRegistered: true,
      status: 'EVENT_REGISTERED',
      orgAttendee,
      eventUser,
    };
  }

  /**
   * Asocia un Firebase UID con un EventUser existente
   * Si ya existe otro UID para el mismo email/evento, lo actualiza
   */
  async associateFirebaseUID(
    eventId: string,
    email: string,
    firebaseUID: string,
  ) {
    // First find the event to get the organization
    const event = await this.model.findById(eventId).lean();
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Find the attendee by email and organization
    const attendee = await this.orgAttendeeModel
      .findOne({
        organizationId: event.orgId,
        email,
      })
      .lean();

    if (!attendee) {
      throw new NotFoundException('Attendee not found');
    }

    // Update EventUser with Firebase UID
    // Usar $in para manejar attendeeId almacenado como ObjectId o como string (inconsistencia legacy)
    const attendeeObjectId = new Types.ObjectId(attendee._id.toString());
    const eventUser = await this.eventUserModel.findOneAndUpdate(
      {
        eventId,
        attendeeId: { $in: [attendeeObjectId, attendee._id.toString()] },
      },
      {
        firebaseUID,
        lastLoginAt: new Date(),
      },
      { new: true },
    );

    if (!eventUser) {
      // Let's debug by checking what EventUsers exist for this event
      const allEventUsers = await this.eventUserModel.find({ eventId }).lean();

      throw new NotFoundException('EventUser not found');
    }

    return { success: true, eventUser };
  }

  /**
   * Crea EventUser para un attendee existente (cuando ya está registrado en la organización)
   */
  async createEventUserForExistingAttendee(
    eventId: string,
    attendeeId: string,
  ) {
    // Verificar que el evento existe y obtener orgId
    const event = await this.model.findById(eventId, { orgId: 1 }).lean();
    if (!event) throw new NotFoundException('Event not found');

    // Obtener datos del attendee
    const attendee = await this.orgAttendeeModel.findById(attendeeId).lean();
    if (!attendee) throw new NotFoundException('Attendee not found');

    // Verificar que el attendee pertenece a la misma organización
    if (attendee.organizationId.toString() !== event.orgId.toString()) {
      throw new BadRequestException(
        'Attendee does not belong to this organization',
      );
    }

    // Crear EventUser si no existe
    const eventUser = await this.eventUserModel
      .findOneAndUpdate(
        { eventId, attendeeId },
        {
          eventId,
          attendeeId,
          status: 'registered',
          registeredAt: new Date(),
          checkedIn: false,
        },
        { upsert: true, new: true },
      )
      .lean();

    // Agregar el eventId al attendee si no está ya
    await this.orgAttendeeModel.findByIdAndUpdate(attendeeId, {
      $addToSet: { eventIds: eventId },
    });

    return { attendee, eventUser };
  }

  /**
   * Obtiene la información de registro de un usuario en un evento
   */
  async getEventUserRegistration(eventId: string, email: string) {
    // Find the event and attendee first
    const event = await this.model.findById(eventId).lean();
    if (!event) return null;

    const attendee = await this.orgAttendeeModel
      .findOne({
        organizationId: event.orgId,
        email,
      })
      .lean();

    if (!attendee) return null;

    return this.eventUserModel
      .findOne({
        eventId,
        attendeeId: attendee._id,
      })
      .populate('attendeeId')
      .lean();
  }

  /**
   * Lista todos los usuarios registrados en un evento
   */
  async listEventUsers(eventId: string) {
    return this.eventUserModel
      .find({ eventId })
      .sort({ registeredAt: -1 })
      .lean();
  }

  /**
   * Marca la asistencia de un usuario al evento en vivo
   */
  async markAttendance(eventId: string, email: string) {
    // Find the event and attendee first
    const event = await this.model.findById(eventId).lean();
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const attendee = await this.orgAttendeeModel
      .findOne({
        organizationId: event.orgId,
        email,
      })
      .lean();

    if (!attendee) {
      throw new NotFoundException('Attendee not found');
    }

    return this.eventUserModel
      .findOneAndUpdate(
        { eventId, attendeeId: attendee._id },
        {
          attendedAt: new Date(),
          status: 'attended',
        },
        { new: true },
      )
      .lean();
  }

  /**
   * Busca un registro existente por campos identificadores
   */
  async findRegistrationByIdentifiers(
    eventId: string,
    identifiers: Record<string, string>,
  ) {
    // Verificar que el evento existe y obtener orgId
    const event = await this.model.findById(eventId, { orgId: 1 }).lean();
    if (!event) throw new NotFoundException('Event not found');

    const organizationId = event.orgId;

    // Construir query para buscar en registrationData
    const query: any = { organizationId };

    // Agregar condiciones para cada campo identificador
    Object.entries(identifiers).forEach(([fieldId, value]) => {
      query[`registrationData.${fieldId}`] = value;
    });

    // Buscar el attendee
    const attendee = await this.orgAttendeeModel.findOne(query).lean();

    if (!attendee) {
      return null;
    }

    // Buscar el EventUser asociado
    const attendeeId = attendee._id.toString();
    const eventUser = await this.eventUserModel
      .findOne({ eventId, attendeeId })
      .lean();

    return {
      attendee,
      eventUser,
      isRegistered: !!eventUser,
    };
  }

  /**
   * Actualiza los datos de un registro existente
   */
  async updateRegistration(
    attendeeId: string,
    formData: Record<string, any>,
    metadata?: Record<string, any>,
  ) {
    // Primero obtener el attendee actual para comparar email
    const currentAttendee = await this.orgAttendeeModel
      .findById(attendeeId)
      .lean();
    if (!currentAttendee) {
      throw new NotFoundException('Attendee not found');
    }

    // Extraer email del formData si existe
    const newEmail = Object.values(formData).find(
      (value) => typeof value === 'string' && value.includes('@'),
    ) as string | undefined;

    // Actualizar OrgAttendee
    const attendee = await this.orgAttendeeModel
      .findByIdAndUpdate(
        attendeeId,
        {
          registrationData: formData,
          ...(newEmail && { email: newEmail }), // Actualizar email si se proporciona
          ...(metadata && { metadata }),
          updatedAt: new Date(),
        },
        { new: true },
      )
      .lean();

    if (!attendee) {
      throw new NotFoundException('Attendee not found');
    }

    // Si el email cambió, actualizar todos los EventUser relacionados
    if (newEmail && newEmail !== currentAttendee.email) {
      await this.eventUserModel.updateMany({ attendeeId }, { email: newEmail });
    }

    return attendee;
  }

  /**
   * Actualiza el branding específico del evento
   */
  async updateBranding(eventId: string, brandingDto: UpdateEventBrandingDto) {
    // Construir el objeto de branding eliminando campos undefined
    const branding = JSON.parse(JSON.stringify(brandingDto));

    const event = await this.model
      .findByIdAndUpdate(eventId, { branding }, { new: true })
      .lean();

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return event;
  }

  /**
   * Reset de emergencia: limpia estado cuando LiveKit falla o se desincroniza
   * - Detiene egress en LiveKit si existe
   * - Elimina config de DB
   * - Limpia estado en RTDB
   */
  async emergencyResetState(eventSlug: string) {
    this.logger.log(`🚨 Emergency reset requested for event: ${eventSlug}`);

    const results = {
      egressStopped: false,
      configDeleted: false,
      rtdbCleared: false,
      errors: [] as string[],
    };

    try {
      // 1. Buscar config en DB
      let config: any = null;
      try {
        config = await this.liveConfigService.get(eventSlug);
      } catch (err: any) {
        this.logger.log('ℹ️ No config found in DB');
      }

      if (config?.activeEgressId) {
        // 2. Intentar detener egress en LiveKit
        try {
          await this.livekitEgressService.stopEgress(config.activeEgressId);
          results.egressStopped = true;
          this.logger.log(`✅ Egress ${config.activeEgressId} stopped`);
        } catch (err: any) {
          const msg = `Failed to stop egress: ${err.message}`;
          results.errors.push(msg);
          this.logger.warn(`⚠️ ${msg}`);
        }

        // 3. Resetear config en DB (limpiar activeEgressId y status)
        try {
          await this.liveConfigService.update(eventSlug, {
            activeEgressId: '',
            status: 'idle',
            lastError: 'Reset manual',
          });
          results.configDeleted = true;
          this.logger.log(`✅ Config reset in DB`);
        } catch (err: any) {
          const msg = `Failed to reset config: ${err.message}`;
          results.errors.push(msg);
          this.logger.error(`❌ ${msg}`);
        }
      } else {
        this.logger.log('ℹ️ No active egress config found');
      }

      // 4. Limpiar RTDB
      try {
        await this.rtdb.ref(`/live/${eventSlug}/egressId`).remove();
        await this.rtdb.ref(`/live/${eventSlug}/egressStatus`).remove();
        results.rtdbCleared = true;
        this.logger.log(`✅ RTDB state cleared`);
      } catch (err: any) {
        const msg = `Failed to clear RTDB: ${err.message}`;
        results.errors.push(msg);
        this.logger.error(`❌ ${msg}`);
      }

      return {
        success: results.errors.length === 0,
        message:
          results.errors.length === 0
            ? 'Estado reseteado exitosamente'
            : `Reset parcial con ${results.errors.length} error(es)`,
        details: results,
      };
    } catch (err: any) {
      this.logger.error(`❌ Emergency reset failed: ${err.message}`);
      return {
        success: false,
        message: `Error durante reset: ${err.message}`,
        details: results,
      };
    }
  }

  /**
   * Elimina un evento y todos sus datos asociados.
   * No elimina los OrgAttendee, solo desvincula el eventId de sus arrays.
   */
  async deleteEvent(eventId: string) {
    const event = await this.model
      .findById(eventId, { slug: 1, orgId: 1 })
      .lean();
    if (!event) throw new NotFoundException('Event not found');

    const slug = event.slug as string;
    const oidStr = new Types.ObjectId(eventId);

    await Promise.all([
      // Datos del evento
      this.eventUserModel.deleteMany({ eventId }),
      this.viewingSessionModel.deleteMany({ eventId }),
      this.eventMetricsModel.deleteMany({ eventId }),
      this.pollModel.deleteMany({ eventId: oidStr }),
      // Emails
      this.emailTemplateService.deleteByEventId(eventId),
      this.emailCampaignService.deleteByEventId(eventId),
      // Config de streaming
      this.liveConfigService.deleteByEventSlug(slug),
      // Desvincular attendees (sin borrarlos)
      this.orgAttendeeModel.updateMany(
        { eventIds: oidStr },
        { $pull: { eventIds: oidStr } },
      ),
      // RTDB
      this.rtdb.ref(`/events/${eventId}`).remove(),
      this.rtdb.ref(`/presence/${eventId}`).remove(),
      this.rtdb.ref(`/announcements/${eventId}`).remove(),
      this.rtdb.ref(`/metrics/${eventId}`).remove(),
    ]);

    await this.model.findByIdAndDelete(eventId);
    return { ok: true };
  }

  /**
   * Valida si un egress existe en LiveKit
   */
  async validateEgressExists(egressId: string) {
    try {
      const egressInfo = await this.livekitEgressService.getEgress(egressId);
      return {
        exists: true,
        egressId,
        status: egressInfo.status || 'unknown',
      };
    } catch (err: any) {
      return {
        exists: false,
        egressId,
        error: err.message,
      };
    }
  }

  async transferEvent(
    eventId: string,
    targetOrgId: string,
    newSlug: string | undefined,
    requesterUid: string,
  ) {
    const event = await this.model.findById(eventId);
    if (!event) throw new NotFoundException('Evento no encontrado');

    const sourceOrg = await this.orgModel
      .findById(event.orgId, { ownerUid: 1 })
      .lean();
    if (!sourceOrg || sourceOrg.ownerUid !== requesterUid) {
      throw new ForbiddenException('No eres dueño del org origen');
    }

    const targetOrg = await this.orgModel
      .findById(targetOrgId, { ownerUid: 1 })
      .lean();
    if (!targetOrg) throw new NotFoundException('Org destino no encontrado');
    if (targetOrg.ownerUid !== requesterUid) {
      throw new ForbiddenException('No eres dueño del org destino');
    }

    const finalSlug = newSlug || event.slug;

    const conflict = await this.model
      .findOne({ orgId: new Types.ObjectId(targetOrgId), slug: finalSlug })
      .lean();
    if (conflict) {
      throw new ConflictException(
        `El slug "${finalSlug}" ya existe en el org destino`,
      );
    }

    event.orgId = new Types.ObjectId(targetOrgId);
    event.slug = finalSlug;
    return (await event.save()).toObject();
  }
}
