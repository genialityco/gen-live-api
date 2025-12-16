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
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
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

@Injectable()
export class EventsService implements OnModuleInit {
  private logger = console;

  constructor(
    @InjectModel(Event.name) private model: Model<EventDocument>,
    @Inject(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name) private orgAttendeeModel: Model<OrgAttendee>,
    private rtdb: RtdbService,
    private watcher: RtdbPresenceWatcherService,
    private metricsService: ViewingMetricsService,
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
      .findByIdAndUpdate(eventId, updates, { new: true })
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

  async listByOrgIdPublic(orgId: string) {
    try {
      const objectId = new Types.ObjectId(orgId);
      // Retorna solo información pública de los eventos incluyendo branding
      return this.model
        .find({ orgId: objectId })
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
    return this.model.create({
      orgId: new this.model.db.base.Types.ObjectId(dto.orgId),
      slug: clean(dto.slug),
      title: dto.title.trim(),
      schedule: dto.schedule,
      stream: dto.stream,
      status: 'upcoming',
    });
  }

  async updateStream(
    eventId: string,
    payload: { provider: 'vimeo'; url: string; meta?: any },
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
  async registerUserToEvent(eventId: string, dto: RegisterToEventDto) {
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

    const eventUser = await this.eventUserModel.findOneAndUpdate(
      {
        eventId,
        attendeeId: attendee._id, // Mongoose handles ObjectId comparison automatically
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
}
