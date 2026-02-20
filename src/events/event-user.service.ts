import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventUser } from './schemas/event-user.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { UserAccount } from '../users/schemas/user-account.schema';
import { ViewingSession } from './schemas/viewing-session.schema';

@Injectable()
export class EventUserService {
  constructor(
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    @InjectModel(UserAccount.name)
    private userAccountModel: Model<UserAccount>,
    @InjectModel(ViewingSession.name)
    private viewingSessionModel: Model<ViewingSession>,
  ) {}

  // Verificar si un usuario está registrado en un evento
  async checkRegistration(firebaseUid: string, eventId: string) {
    try {
      // 1. Buscar UserAccount por Firebase UID
      const userAccount = await this.userAccountModel
        .findOne({ firebaseUid })
        .lean();

      if (!userAccount) {
        return { isRegistered: false, reason: 'User account not found' };
      }

      // 2. Buscar OrgAttendee asociado al UserAccount
      const orgAttendee = await this.orgAttendeeModel
        .findOne({ userAccountId: userAccount._id })
        .lean();

      if (!orgAttendee) {
        return { isRegistered: false, reason: 'Org attendee not found' };
      }

      // 3. Buscar EventUser asociado al OrgAttendee y Event
      const eventUser = await this.eventUserModel
        .findOne({
          attendeeId: orgAttendee._id,
          eventId: eventId,
          status: { $ne: 'cancelled' },
        })
        .populate('attendeeId')
        .lean();

      if (!eventUser) {
        return { isRegistered: false, reason: 'Event registration not found' };
      }

      return {
        isRegistered: true,
        eventUser,
        orgAttendee,
        userAccount,
      };
    } catch (error: any) {
      throw new BadRequestException(
        'Error checking registration: ' + String(error),
      );
    }
  }

  // Buscar EventUser por attendeeId y eventId
  async findByAttendeeAndEvent(attendeeId: string, eventId: string) {
    const eventUser = await this.eventUserModel
      .findOne({ attendeeId, eventId })
      .populate('attendeeId')
      .lean();

    if (!eventUser) {
      throw new NotFoundException(
        `EventUser not found for attendee ${attendeeId} and event ${eventId}`,
      );
    }

    return eventUser;
  }

  // Asociar Firebase UID con un EventUser existente
  async associateFirebaseUid(
    attendeeId: string,
    eventId: string,
    firebaseUID: string,
  ) {
    const eventUser = await this.eventUserModel.findOneAndUpdate(
      { attendeeId, eventId },
      {
        firebaseUID,
        lastLoginAt: new Date(),
      },
      { new: true },
    );

    if (!eventUser) {
      throw new NotFoundException(
        `EventUser not found for attendee ${attendeeId} and event ${eventId}`,
      );
    }

    return eventUser;
  }

  // Registrar usuario en un evento (crear EventUser)
  async registerUserToEvent(
    attendeeId: string,
    eventId: string,
    firebaseUID?: string,
  ) {
    // Verificar que no esté ya registrado
    const existingEventUser = await this.eventUserModel.findOne({
      attendeeId: { $in: [new Types.ObjectId(attendeeId), attendeeId] },
      eventId,
    });

    if (existingEventUser) {
      // Si ya existe pero fue cancelado, reactivar
      if (existingEventUser.status === 'cancelled') {
        existingEventUser.status = 'registered';
        existingEventUser.registeredAt = new Date();
        existingEventUser.firebaseUID =
          firebaseUID || existingEventUser.firebaseUID;
        await existingEventUser.save();
        return existingEventUser.toObject();
      }

      throw new BadRequestException('User already registered to this event');
    }

    const eventUser = await this.eventUserModel.create({
      attendeeId: new Types.ObjectId(attendeeId),
      eventId,
      firebaseUID,
      status: 'registered',
      registeredAt: new Date(),
      lastLoginAt: firebaseUID ? new Date() : undefined,
    });

    return eventUser.toObject();
  }

  // Actualizar último login
  async updateLastLogin(attendeeId: string, eventId: string) {
    const eventUser = await this.eventUserModel.findOneAndUpdate(
      { attendeeId, eventId },
      { lastLoginAt: new Date() },
      { new: true },
    );

    if (!eventUser) {
      throw new NotFoundException(
        `EventUser not found for attendee ${attendeeId} and event ${eventId}`,
      );
    }

    return eventUser;
  }

  // Marcar como asistido
  async markAsAttended(attendeeId: string, eventId: string) {
    console.log('[markAsAttended] raw args:', { attendeeId, eventId });

    const filter = {
      attendeeId: { $in: [new Types.ObjectId(attendeeId), attendeeId] },
      eventId: String(eventId),
    };

    const eventUser = await this.eventUserModel.findOneAndUpdate(
      filter,
      {
        status: 'attended',
        attendedAt: new Date(),
        checkedIn: true,
        checkedInAt: new Date(),
      },
      { new: true },
    );

    if (!eventUser) {
      // Extra debug: ver qué hay por attendeeId o por eventId
      await this.eventUserModel.find({ attendeeId: filter.attendeeId }).lean();
      await this.eventUserModel.find({ eventId: filter.eventId }).lean();

      throw new NotFoundException(
        `EventUser not found for attendee ${attendeeId} and event ${eventId}`,
      );
    }

    return eventUser;
  }

  // Obtener todos los usuarios de un evento
  async getEventUsers(eventId: string, status?: string) {
    const filter: Record<string, any> = { eventId };
    if (status) {
      filter.status = status;
    }

    return await this.eventUserModel
      .find(filter)
      .populate(
        'attendeeId',
        'email name registrationData organizationId isActive',
      )
      .sort({ registeredAt: -1 })
      .lean();
  }

  // Obtener eventos de un usuario
  async getUserEvents(userAccountId: string) {
    // Buscar OrgAttendee
    const orgAttendee = await this.orgAttendeeModel
      .findOne({ userAccountId })
      .lean();

    if (!orgAttendee) {
      return [];
    }

    return await this.eventUserModel
      .find({ attendeeId: orgAttendee._id })
      .sort({ registeredAt: -1 })
      .lean();
  }

  // Obtener usuarios que asistieron en vivo (tuvieron ViewingSession)
  async getLiveAttendees(eventId: string): Promise<any[]> {
    // Obtener todas las sesiones que estuvieron durante el live
    const liveSessions = await this.viewingSessionModel
      .find({
        eventId,
        wasLiveDuringSession: true,
      })
      .lean();

    // Obtener IDs únicos de EventUsers
    const uniqueEventUserIds = [
      ...new Set(liveSessions.map((s) => s.eventUserId.toString())),
    ];

    // Obtener los EventUsers con sus attendees populados
    const eventUsers = await this.eventUserModel
      .find({
        _id: { $in: uniqueEventUserIds },
      })
      .populate(
        'attendeeId',
        'email name registrationData organizationId isActive',
      )
      .lean()
      .exec();

    // Agregar información de visualización a cada EventUser
    return eventUsers.map((eventUser: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const eventUserId = eventUser._id.toString() as string;
      const userSessions = liveSessions.filter(
        (s) => s.eventUserId.toString() === eventUserId,
      );

      const totalWatchTime = userSessions.reduce(
        (sum, s) => sum + s.totalWatchTimeSeconds,
        0,
      );
      const liveWatchTime = userSessions.reduce(
        (sum, s) => sum + s.liveWatchTimeSeconds,
        0,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return {
        ...eventUser,
        viewingStats: {
          totalSessions: userSessions.length,
          totalWatchTimeSeconds: totalWatchTime,
          liveWatchTimeSeconds: liveWatchTime,
          lastHeartbeat: userSessions[0]?.lastHeartbeat,
        },
      };
    });
  }
}
