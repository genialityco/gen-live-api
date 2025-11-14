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
    this.logger.log(
      '🔍 Checking for live events to activate presence watchers...',
    );

    try {
      const liveEvents = await this.model.find({ status: 'live' }).lean();

      if (liveEvents.length === 0) {
        this.logger.log('✅ No live events found - no watchers to activate');
        return;
      }

      this.logger.log(
        `🎯 Found ${liveEvents.length} live events, activating watchers...`,
      );

      for (const event of liveEvents) {
        await this.watcher.watch(event._id.toString());
        this.logger.log(
          `✅ Watcher activated for live event: ${event.title} (${event._id})`,
        );
      }

      this.logger.log('🚀 All presence watchers activated successfully');
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

    console.log(
      `🎯 Creating EventUser for eventId: ${eventId}, email: ${dto.email}, attendeeId: ${attendeeObjectId.toString()}`,
    );

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
      console.log(
        `🔗 Including Firebase UID: ${dto.firebaseUID} in EventUser creation`,
      );
    }

    const eventUser = await this.eventUserModel
      .findOneAndUpdate(
        { eventId, attendeeId: attendeeObjectId },
        eventUserData,
        { upsert: true, new: true },
      )
      .populate('attendeeId')
      .lean();

    console.log(`✅ EventUser created/updated:`, {
      _id: eventUser._id,
      eventId: eventUser.eventId,
      attendeeId: eventUser.attendeeId,
      firebaseUID: eventUser.firebaseUID || 'NOT_SET',
      status: eventUser.status,
    });

    return { attendee, eventUser };
  }

  /**
   * Verifica si un usuario ya está registrado en un evento (por email)
   */
  async isUserRegisteredToEvent(
    eventId: string,
    email: string,
  ): Promise<{ isRegistered: boolean; orgAttendee?: any; eventUser?: any }> {
    console.log(
      `🔍 Checking registration for eventId: ${eventId}, email: ${email}`,
    );

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

    console.log(`📋 EventUser found:`, eventUser ? 'YES' : 'NO');
    if (eventUser) {
      console.log(`✅ EventUser details:`, {
        _id: eventUser._id,
        eventId: eventUser.eventId,
        attendeeId: eventUser.attendeeId,
        status: eventUser.status,
        registeredAt: eventUser.registeredAt,
      });
    }

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
    console.log(
      `🔍 Checking registration by UID for eventId: ${eventId}, firebaseUID: ${firebaseUID}`,
    );

    const eventUser = await this.eventUserModel
      .findOne({ eventId, firebaseUID })
      .lean();

    console.log(`📋 EventUser found by UID:`, eventUser ? 'YES' : 'NO');
    if (eventUser) {
      console.log(`✅ EventUser details:`, {
        _id: eventUser._id,
        eventId: eventUser.eventId,
        attendeeId: eventUser.attendeeId,
        firebaseUID: eventUser.firebaseUID,
        status: eventUser.status,
      });
    }

    return !!eventUser;
  }

  /**
   * Verifica registro usando campos identificadores del formulario
   * Retorna: { isRegistered: boolean, orgAttendee?: OrgAttendee, eventUser?: EventUser }
   */
  async checkRegistrationByIdentifiers(
    eventId: string,
    identifierFields: Record<string, any>,
  ) {
    console.log(
      `🔍 Checking registration by identifiers for eventId: ${eventId}`,
      identifierFields,
    );

    // 1. Obtener el evento y su organizationId
    const event = await this.model.findById(eventId).lean();
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // 2. Buscar OrgAttendee usando los campos identificadores
    const query: any = { organizationId: event.orgId };
    Object.entries(identifierFields).forEach(([fieldName, value]) => {
      query[`registrationData.${fieldName}`] = value;
    });

    const orgAttendee = await this.orgAttendeeModel.findOne(query).lean();

    if (!orgAttendee) {
      console.log('❌ OrgAttendee not found with identifiers');
      return {
        isRegistered: false,
        message: 'No registration found for this organization',
      };
    }

    console.log('✅ OrgAttendee found:', orgAttendee._id);

    // 3. Verificar si existe EventUser para este evento
    const eventUser = await this.eventUserModel
      .findOne({ eventId, attendeeId: orgAttendee._id })
      .lean();

    if (!eventUser) {
      console.log('⚠️  OrgAttendee exists but not registered to this event');
      return {
        isRegistered: false,
        orgAttendee: orgAttendee,
        message:
          'User found in organization but not registered to this specific event',
      };
    }

    console.log('✅ EventUser found - User is registered to this event');
    return {
      isRegistered: true,
      orgAttendee: orgAttendee,
      eventUser: eventUser,
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
    console.log(
      `🔗 Associating Firebase UID ${firebaseUID} with email ${email} for event ${eventId}`,
    );

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
      console.log(
        `❌ OrgAttendee not found for email: ${email}, orgId: ${event.orgId.toString()}`,
      );
      throw new NotFoundException('Attendee not found');
    }

    // Update EventUser with Firebase UID
    console.log(
      `🔍 Looking for EventUser with attendeeId: ${attendee._id.toString()}, eventId: ${eventId}`,
    );

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
      console.log(
        `❌ EventUser not found for attendeeId: ${attendee._id.toString()}, eventId: ${eventId}`,
      );

      // Let's debug by checking what EventUsers exist for this event
      const allEventUsers = await this.eventUserModel.find({ eventId }).lean();
      console.log(
        `🔍 All EventUsers for eventId ${eventId}:`,
        allEventUsers.map((eu) => ({
          _id: eu._id,
          attendeeId: eu.attendeeId,
          firebaseUID: eu.firebaseUID,
        })),
      );

      throw new NotFoundException('EventUser not found');
    }

    console.log(`✅ Associated Firebase UID with EventUser:`, {
      _id: eventUser._id,
      attendeeId: eventUser.attendeeId,
      firebaseUID: eventUser.firebaseUID,
      lastLoginAt: eventUser.lastLoginAt,
    });

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
      console.log(
        `📧 Updating email in EventUsers from ${currentAttendee.email} to ${newEmail} for attendeeId: ${attendeeId}`,
      );

      await this.eventUserModel.updateMany({ attendeeId }, { email: newEmail });

      console.log(`✅ Updated EventUsers with new email: ${newEmail}`);
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
