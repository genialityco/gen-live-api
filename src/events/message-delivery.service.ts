import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
import {
  DeliveryChannel,
  DeliveryFeature,
  MessageDelivery,
} from './schemas/message-delivery.schema';
import { RecordDeliveryDto } from './dtos/record-delivery.dto';

const STATUS_TTL_MS = 15_000;
const ATTENDEE_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 30_000;
const ATTENDEE_CACHE_MAX = 20_000;

/** Totales de mensajes mostrados en un evento */
export type DeliveryTotals = {
  herdPrivate: number;
  herdPublic: number;
  milestone: number;
  greeting: number;
  // Personas distintas que vieron al menos un mensaje
  attendees: number;
};

/**
 * Registro de los mensajes que se le mostraron a cada asistente (ver
 * MessageDelivery). Solo cuenta con el evento en vivo y para espectadores
 * inscritos (con EventUser): el egress del estudio o un admin en vista
 * previa no ensucian la medición.
 */
@Injectable()
export class MessageDeliveryService {
  private readonly logger = new Logger(MessageDeliveryService.name);
  private statusCache = new Map<string, { status: string; at: number }>();
  private attendeeCache = new Map<
    string,
    { attendeeId: string | null; at: number }
  >();

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(MessageDelivery.name)
    private deliveryModel: Model<MessageDelivery>,
  ) {}

  async record(eventId: string, uid: string, dto: RecordDeliveryDto) {
    if (!Types.ObjectId.isValid(eventId)) return { ok: false };
    if ((await this.status(eventId)) !== 'live') return { ok: false };
    const attendeeId = await this.attendeeOf(eventId, uid);
    if (!attendeeId) return { ok: false };
    try {
      await this.deliveryModel.create({
        eventId,
        attendeeId,
        uid,
        feature: dto.feature,
        channel: dto.channel,
        source: dto.source,
        groupKey: dto.groupKey,
        refId: dto.refId,
      });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      // Mismo mensaje reportado dos veces: ya está contado
      if (e?.code !== 11000) {
        this.logger.warn(
          `No se pudo registrar la entrega en ${eventId}: ${e?.message ?? String(err)}`,
        );
        return { ok: false };
      }
    }
    return { ok: true };
  }

  /** Totales por evento */
  async totalsByEvent(
    eventIds: string[],
  ): Promise<Map<string, DeliveryTotals>> {
    const out = new Map<string, DeliveryTotals>();
    if (!eventIds.length) return out;
    const rows = await this.deliveryModel.aggregate<{
      _id: {
        eventId: string;
        feature: DeliveryFeature;
        channel: DeliveryChannel;
      };
      n: number;
      people: string[];
    }>([
      { $match: { eventId: { $in: eventIds } } },
      {
        $group: {
          _id: {
            eventId: '$eventId',
            feature: '$feature',
            channel: '$channel',
          },
          n: { $sum: 1 },
          people: { $addToSet: '$attendeeId' },
        },
      },
    ]);
    const people = new Map<string, Set<string>>();
    for (const r of rows) {
      const id = r._id.eventId;
      const t = out.get(id) ?? {
        herdPrivate: 0,
        herdPublic: 0,
        milestone: 0,
        greeting: 0,
        attendees: 0,
      };
      if (r._id.feature === 'herd') {
        if (r._id.channel === 'private') t.herdPrivate += r.n;
        else t.herdPublic += r.n;
      } else if (r._id.feature === 'milestone') {
        t.milestone += r.n;
      } else {
        t.greeting += r.n;
      }
      out.set(id, t);
      const set = people.get(id) ?? new Set<string>();
      r.people.forEach((p) => set.add(p));
      people.set(id, set);
    }
    for (const [id, t] of out) t.attendees = people.get(id)?.size ?? 0;
    return out;
  }

  /**
   * Mensajes mostrados por asistente y evento (clave `${eventId}:${attendeeId}`).
   * Solo los personales (privados), que son los que distinguen tratamiento de
   * control; los públicos los ve cualquiera que no esté en el control.
   */
  async privateByAttendee(eventIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!eventIds.length) return out;
    const rows = await this.deliveryModel.aggregate<{
      _id: { eventId: string; attendeeId: string };
      n: number;
    }>([
      { $match: { eventId: { $in: eventIds }, channel: 'private' } },
      {
        $group: {
          _id: { eventId: '$eventId', attendeeId: '$attendeeId' },
          n: { $sum: 1 },
        },
      },
    ]);
    for (const r of rows) {
      out.set(`${r._id.eventId}:${r._id.attendeeId}`, r.n);
    }
    return out;
  }

  /** Primer mensaje mostrado a cada asistente de un evento (ms) */
  async firstShownByAttendee(eventId: string): Promise<Map<string, number>> {
    const rows = await this.deliveryModel.aggregate<{
      _id: string;
      first: Date;
    }>([
      { $match: { eventId } },
      { $group: { _id: '$attendeeId', first: { $min: '$createdAt' } } },
    ]);
    return new Map(rows.map((r) => [r._id, new Date(r.first).getTime()]));
  }

  private async status(eventId: string) {
    const hit = this.statusCache.get(eventId);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const ev = await this.eventModel.findById(eventId, { status: 1 }).lean();
    const status = ev?.status ?? 'missing';
    this.statusCache.set(eventId, { status, at: Date.now() });
    return status;
  }

  private async attendeeOf(eventId: string, uid: string) {
    const key = `${eventId}:${uid}`;
    const hit = this.attendeeCache.get(key);
    // Sin inscripción se vuelve a consultar pronto: puede estar registrándose
    const ttl = hit?.attendeeId ? ATTENDEE_TTL_MS : MISSING_TTL_MS;
    if (hit && Date.now() - hit.at < ttl) return hit.attendeeId;
    const eu = await this.eventUserModel
      .findOne({ eventId, firebaseUID: uid }, { attendeeId: 1 })
      .lean();
    const attendeeId = eu?.attendeeId ? String(eu.attendeeId) : null;
    if (this.attendeeCache.size >= ATTENDEE_CACHE_MAX) {
      this.attendeeCache.clear();
    }
    this.attendeeCache.set(key, { attendeeId, at: Date.now() });
    return attendeeId;
  }
}
