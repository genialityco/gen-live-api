/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-base-to-string */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { HerdAnnouncement } from './schemas/herd-announcement.schema';
import { MilestoneAward } from './schemas/milestone-award.schema';
import { HerdGreeting } from './schemas/herd-greeting.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { HerdService } from './herd.service';
import { milestoneHoldout } from './milestones.service';

/** Brazo de un sorteo: 1 ve los mensajes · 0 control · null sin sorteo */
type Arm = 1 | 0 | null;
import { resolveLiveEnd, stayedUntilEnd } from './live-window';
import {
  DeliveryTotals,
  MessageDeliveryService,
} from './message-delivery.service';

/** Tipo de evento según las funciones de retención que tuvo */
export type EngagementKind = 'base' | 'herd' | 'milestones' | 'both';

/**
 * Qué vivió el asistente en un evento:
 * - T: recibió mensajes (tratamiento de manada o logro privado entregado)
 * - C: grupo de control sorteado (manada o logros): no los recibió, al azar
 * - X: su grupo de manada está excluido (no recibe mensajes)
 * - N: evento con funciones pero sin mensajes personales para él (sin grupo)
 * - B: evento sin anuncios ni logros
 */
export type ExposureStatus = 'T' | 'C' | 'X' | 'N' | 'B';

/**
 * Saludo entre colegas del asistente en un evento:
 * [botón (1 vio el anuncio con botón · 0 control sin botón · null no vio
 * anuncio individual), saludos enviados, saludos que devolvió, devoluciones
 * que recibió a sus saludos]
 */
export type GreetingVisit = [1 | 0 | null, number, number, number];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Percentil p (0..1) de una lista ya ordenada ascendente */
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

type Visit = {
  eventId: string;
  liveMin: number;
  lastSeen: number;
  firstAt: number;
};

/**
 * Análisis de permanencia de una organización: cuánto se quedó cada asistente
 * en vivo en cada evento, si recibió mensajes (anuncios de manada o logros) y
 * a qué grupo de especialistas pertenece. Devuelve datos crudos y compactos:
 * la página hace las comparaciones (mismo grupo con y sin mensajes, misma
 * persona con y sin mensajes, eventos base vs. con funciones) para que el
 * admin pueda filtrar y reclasificar sin volver a consultar.
 *
 * La permanencia se mide con el tiempo de REPRODUCCIÓN en vivo
 * (playbackLiveSeconds): no cuenta cuenta regresiva, pausas ni pestañas de
 * fondo. Los eventos anteriores a ese rastreo (jun-2026) quedan marcados
 * como sin datos de reproducción.
 */
@Injectable()
export class EngagementAnalysisService {
  private readonly logger = new Logger(EngagementAnalysisService.name);

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(ViewingSession.name)
    private viewingSessionModel: Model<ViewingSession>,
    @InjectModel(HerdAnnouncement.name)
    private announcementModel: Model<HerdAnnouncement>,
    @InjectModel(MilestoneAward.name)
    private awardModel: Model<MilestoneAward>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    @InjectModel(HerdGreeting.name)
    private greetingModel: Model<HerdGreeting>,
    private herd: HerdService,
    private deliveries: MessageDeliveryService,
  ) {}

  async forOrg(orgId: string) {
    const events = await this.eventModel
      .find(
        { orgId: new Types.ObjectId(orgId) },
        {
          title: 1,
          slug: 1,
          status: 1,
          schedule: 1,
          endedAt: 1,
          liveStartedAt: 1,
          liveEndedAt: 1,
          hidden: 1,
          createdAt: 1,
          'herdConfig.enabled': 1,
          'herdConfig.holdoutPercent': 1,
          'herdConfig.greeting.enabled': 1,
          'herdConfig.greeting.holdoutPercent': 1,
          'milestonesConfig.enabled': 1,
          'milestonesConfig.holdoutPercent': 1,
          'milestonesConfig.items': 1,
        },
      )
      .lean();
    const eventIds = events.map((e) => String(e._id));
    if (!eventIds.length) return { events: [], attendees: [] };

    // Por espectador (EventUser): solo sesiones que tocaron el vivo
    const [
      rows,
      announcements,
      awardRows,
      greetingRows,
      deliveredByEvent,
      privateShown,
    ] = await Promise.all([
      this.viewingSessionModel.aggregate<{
        _id: unknown;
        eventId: string;
        playbackLive: number;
        lastSeen: Date;
        firstAt: Date;
      }>([
        {
          $match: {
            eventId: { $in: eventIds },
            wasLiveDuringSession: true,
          },
        },
        {
          $group: {
            _id: '$eventUserId',
            eventId: { $first: '$eventId' },
            playbackLive: { $sum: '$playbackLiveSeconds' },
            lastSeen: { $max: '$lastHeartbeat' },
            firstAt: { $min: '$startedAt' },
          },
        },
      ]),
      this.announcementModel.aggregate<{ _id: string; n: number }>([
        { $match: { eventId: { $in: eventIds } } },
        { $group: { _id: '$eventId', n: { $sum: 1 } } },
      ]),
      this.awardModel
        .find(
          { eventId: { $in: eventIds } },
          { _id: 0, eventId: 1, attendeeId: 1, privateSent: 1, holdout: 1 },
        )
        .lean(),
      this.greetingModel
        .find(
          { eventId: { $in: eventIds } },
          {
            _id: 0,
            eventId: 1,
            kind: 1,
            uid: 1,
            attendeeId: 1,
            hasButton: 1,
            toUid: 1,
          },
        )
        .lean(),
      // Mensajes que efectivamente se mostraron (registro desde nov-2026)
      this.deliveries.totalsByEvent(eventIds),
      this.deliveries.privateByAttendee(eventIds),
    ]);
    const annByEvent = new Map(announcements.map((a) => [a._id, a.n]));

    // Logros por evento: totales y, por asistente, si se le entregó en
    // privado o cayó en el control
    const awardsByEvent = new Map<string, { n: number; shown: number }>();
    const awardOf = new Map<string, { sent: boolean; holdout: boolean }>();
    for (const a of awardRows) {
      const agg = awardsByEvent.get(a.eventId) ?? { n: 0, shown: 0 };
      agg.n++;
      if (!a.holdout) agg.shown++;
      awardsByEvent.set(a.eventId, agg);
      const k = `${a.eventId}:${a.attendeeId}`;
      const prev = awardOf.get(k) ?? { sent: false, holdout: false };
      awardOf.set(k, {
        sent: prev.sent || !!a.privateSent,
        holdout: prev.holdout || !!a.holdout,
      });
    }

    // Saludos entre colegas: por asistente y evento, y totales por evento.
    // Las devoluciones apuntan al UID de quien saludó: se traduce a asistente
    // con los propios registros del evento.
    const attendeeOfUid = new Map<string, string>();
    for (const g of greetingRows) {
      if (g.attendeeId) {
        attendeeOfUid.set(`${g.eventId}:${g.uid}`, g.attendeeId);
      }
    }
    const greetOf = new Map<string, GreetingVisit>();
    const greetEntry = (eventId: string, attendeeId: string) => {
      const k = `${eventId}:${attendeeId}`;
      const g = greetOf.get(k) ?? [null, 0, 0, 0];
      greetOf.set(k, g);
      return g;
    };
    type GreetTotals = {
      withButton: Set<string>;
      noButton: Set<string>;
      greets: number;
      replies: number;
    };
    const greetByEvent = new Map<string, GreetTotals>();
    for (const g of greetingRows) {
      const ev: GreetTotals = greetByEvent.get(g.eventId) ?? {
        withButton: new Set<string>(),
        noButton: new Set<string>(),
        greets: 0,
        replies: 0,
      };
      greetByEvent.set(g.eventId, ev);
      if (g.kind === 'greet') ev.greets++;
      if (g.kind === 'reply') {
        ev.replies++;
        const to = g.toUid && attendeeOfUid.get(`${g.eventId}:${g.toUid}`);
        if (to) greetEntry(g.eventId, to)[3]++;
      }
      const aid = g.attendeeId ?? attendeeOfUid.get(`${g.eventId}:${g.uid}`);
      if (!aid) continue;
      const entry = greetEntry(g.eventId, aid);
      if (g.kind === 'impression') {
        (g.hasButton ? ev.withButton : ev.noButton).add(aid);
        entry[0] = g.hasButton || entry[0] === 1 ? 1 : 0;
      } else if (g.kind === 'greet') {
        entry[1]++;
      } else if (g.kind === 'reply') {
        entry[2]++;
      }
    }

    // EventUser → asistente de la org
    const euIds = rows.map((r) => r._id);
    const eventUsers = euIds.length
      ? await this.eventUserModel
          .find({ _id: { $in: euIds } }, { _id: 1, attendeeId: 1 })
          .lean()
      : [];
    const attendeeOfEu = new Map(
      eventUsers.map((eu) => [String(eu._id), String(eu.attendeeId)]),
    );

    // Por asistente y evento (un asistente con dos EventUser en el mismo
    // evento se suma)
    const visitsByAttendee = new Map<string, Map<string, Visit>>();
    const firstLiveByEvent = new Map<string, number>();
    for (const r of rows) {
      const aid = attendeeOfEu.get(String(r._id));
      if (!aid) continue;
      const v: Visit = {
        eventId: r.eventId,
        liveMin: (r.playbackLive ?? 0) / 60,
        lastSeen: r.lastSeen ? new Date(r.lastSeen).getTime() : 0,
        firstAt: r.firstAt ? new Date(r.firstAt).getTime() : 0,
      };
      const byEvent = visitsByAttendee.get(aid) ?? new Map<string, Visit>();
      const prev = byEvent.get(r.eventId);
      if (prev) {
        prev.liveMin += v.liveMin;
        prev.lastSeen = Math.max(prev.lastSeen, v.lastSeen);
        prev.firstAt = Math.min(prev.firstAt, v.firstAt);
      } else {
        byEvent.set(r.eventId, v);
      }
      visitsByAttendee.set(aid, byEvent);
      if (v.firstAt) {
        firstLiveByEvent.set(
          r.eventId,
          Math.min(firstLiveByEvent.get(r.eventId) ?? Infinity, v.firstAt),
        );
      }
    }
    const minutesByEvent = new Map<string, number[]>();
    const lastSeensByEvent = new Map<string, number[]>();
    for (const byEvent of visitsByAttendee.values()) {
      for (const v of byEvent.values()) {
        const list = minutesByEvent.get(v.eventId) ?? [];
        list.push(v.liveMin);
        minutesByEvent.set(v.eventId, list);
        const seen = lastSeensByEvent.get(v.eventId) ?? [];
        seen.push(v.lastSeen);
        lastSeensByEvent.set(v.eventId, seen);
      }
    }

    // Solo eventos con espectadores en vivo, en orden cronológico
    const outEvents = events
      .filter((e) => minutesByEvent.has(String(e._id)))
      .map((e) => {
        const id = String(e._id);
        const played = (minutesByEvent.get(id) ?? [])
          .filter((m) => m > 0)
          .sort((a, b) => a - b);
        const herdAnnouncements = annByEvent.get(id) ?? 0;
        const award = awardsByEvent.get(id);
        const herdOn = !!e.herdConfig?.enabled || herdAnnouncements > 0;
        const milestonesOn =
          (!!e.milestonesConfig?.enabled &&
            (e.milestonesConfig.items ?? []).some(
              (i) => i.enabled !== false,
            )) ||
          (award?.n ?? 0) > 0;
        const kind: EngagementKind =
          herdOn && milestonesOn
            ? 'both'
            : herdOn
              ? 'herd'
              : milestonesOn
                ? 'milestones'
                : 'base';
        const date =
          firstLiveByEvent.get(id) ??
          (e.schedule?.startsAt
            ? new Date(e.schedule.startsAt).getTime()
            : new Date((e as any).createdAt ?? Date.now()).getTime());
        const liveEnd = resolveLiveEnd(e, lastSeensByEvent.get(id) ?? []);
        const liveStart = e.liveStartedAt
          ? new Date(e.liveStartedAt).getTime()
          : null;
        const delivered: DeliveryTotals | null =
          deliveredByEvent.get(id) ?? null;
        return {
          id,
          title: e.title,
          slug: e.slug,
          status: e.status,
          hidden: !!e.hidden,
          date: new Date(date).toISOString(),
          // Cierre del vivo usado para "hasta el final" (ver resolveLiveEnd)
          endedAt:
            liveEnd.at !== null ? new Date(liveEnd.at).toISOString() : null,
          liveEndSource: liveEnd.source,
          liveStartedAt: liveStart ? new Date(liveStart).toISOString() : null,
          // Duración real del vivo (solo con inicio y cierre registrados)
          liveDurationMin:
            liveStart && liveEnd.source === 'recorded' && liveEnd.at
              ? round1((liveEnd.at - liveStart) / 60_000)
              : null,
          // Mensajes que se mostraron según el registro de entregas; null si el
          // evento no tiene registro (anterior a nov-2026 o sin funciones)
          delivered,
          kind,
          herd: {
            enabled: !!e.herdConfig?.enabled,
            holdoutPercent: e.herdConfig?.holdoutPercent ?? 0,
            announcements: herdAnnouncements,
          },
          milestones: {
            enabled: !!e.milestonesConfig?.enabled,
            holdoutPercent: e.milestonesConfig?.holdoutPercent ?? 0,
            items: (e.milestonesConfig?.items ?? []).filter(
              (i) => i.enabled !== false,
            ).length,
            awards: award?.n ?? 0,
            awardsShown: award?.shown ?? 0,
          },
          greeting: {
            enabled: !!e.herdConfig?.greeting?.enabled,
            holdoutPercent: e.herdConfig?.greeting?.holdoutPercent ?? 0,
            // Personas que vieron el anuncio individual con / sin botón
            withButton: greetByEvent.get(id)?.withButton.size ?? 0,
            noButton: greetByEvent.get(id)?.noButton.size ?? 0,
            greets: greetByEvent.get(id)?.greets ?? 0,
            replies: greetByEvent.get(id)?.replies ?? 0,
          },
          liveViewers: minutesByEvent.get(id)?.length ?? 0,
          // Sin reproducción registrada: evento anterior al rastreo de playback
          hasPlayback: played.length > 0,
          // Duración de referencia del vivo: p95 de lo que vieron (los
          // extremos por varias pestañas no la inflan)
          refMin: round1(percentile(played, 0.95)),
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const eventIndex = new Map(outEvents.map((e, i) => [e.id, i]));
    const kindOf = new Map(outEvents.map((e) => [e.id, e.kind]));
    const endedAtOf = new Map(
      outEvents.map((e) => [
        e.id,
        e.endedAt ? new Date(e.endedAt).getTime() : null,
      ]),
    );
    const hasDeliveries = new Set(
      outEvents.filter((e) => e.delivered).map((e) => e.id),
    );

    const attendeeIds = [...visitsByAttendee.keys()].filter((id) =>
      Types.ObjectId.isValid(id),
    );

    // Manada de cada evento con anuncios: sorteo, grupos excluidos y grupos
    // de cada asistente
    const herdEvents = outEvents.filter(
      (e) => e.kind === 'herd' || e.kind === 'both',
    );
    type HerdInfo = {
      arms: Map<string, string>;
      holdout: boolean;
      excluded: Set<string>;
      groups: Map<string, Array<{ key: string; label: string }>>;
    };
    const herdOf = new Map<string, HerdInfo>();
    for (const e of herdEvents) {
      try {
        const ctx = await this.herd.contextFor(e.id);
        if (!ctx) continue;
        const ids = attendeeIds.filter((id) =>
          visitsByAttendee.get(id)?.has(e.id),
        );
        herdOf.set(e.id, {
          arms: ctx.arms,
          holdout: (ctx.config.holdoutPercent ?? 0) > 0,
          excluded: ctx.excludedKeys,
          groups: await ctx.groupsFor(ids),
        });
      } catch (err) {
        this.logger.warn(
          `Análisis: sin datos de manada para ${e.id}: ${(err as Error).message}`,
        );
      }
    }

    // Grupo de especialistas de cada asistente: el de la manada principal del
    // evento con manada más reciente. Sale del registro en la org, así que
    // vale también para sus eventos sin manada.
    const groupOf = new Map<string, { key: string; label: string }>();
    for (const e of [...herdEvents].reverse()) {
      try {
        const ctx = await this.herd.contextFor(e.id);
        if (!ctx) continue;
        const groups = await ctx.groupsFor(attendeeIds);
        if (!groups.size) continue;
        for (const [id, gs] of groups) {
          if (gs[0]) groupOf.set(id, { key: gs[0].key, label: gs[0].label });
        }
        break;
      } catch {
        // probar con el evento anterior
      }
    }

    const exposure = (eventId: string, attendeeId: string): ExposureStatus => {
      if (kindOf.get(eventId) === 'base') return 'B';
      const award = awardOf.get(`${eventId}:${attendeeId}`);
      if (award?.sent) return 'T';
      const h = herdOf.get(eventId);
      if (h) {
        const gs = h.groups.get(attendeeId) ?? [];
        if (gs.length && gs.every((g) => h.excluded.has(g.key))) return 'X';
        const arm = h.arms.get(attendeeId);
        if (arm === 'c' && h.holdout) return 'C';
        if (arm && gs.length) return 'T';
      }
      if (award?.holdout) return 'C';
      return 'N';
    };

    // Sorteo de cada función por separado (1 ve los mensajes · 0 control ·
    // null sin sorteo). Los dos sorteos son independientes, así que se puede
    // cruzar 2×2 y separar el efecto de los anuncios del de los logros.
    const herdArm = (eventId: string, attendeeId: string): Arm => {
      const h = herdOf.get(eventId);
      if (!h?.holdout) return null;
      const gs = h.groups.get(attendeeId) ?? [];
      if (!gs.length || gs.every((g) => h.excluded.has(g.key))) return null;
      const arm = h.arms.get(attendeeId);
      return arm === 'c' ? 0 : arm === 't' ? 1 : null;
    };
    const milestoneHoldoutOf = new Map(
      outEvents.map((e) => [
        e.id,
        e.kind === 'milestones' || e.kind === 'both'
          ? e.milestones.holdoutPercent
          : 0,
      ]),
    );
    // El sorteo de logros es determinista por asistente: vale también para
    // quien no llegó a ningún hito (comparación por intención de tratar)
    const milestoneArm = (eventId: string, attendeeId: string): Arm => {
      const pct = milestoneHoldoutOf.get(eventId) ?? 0;
      if (pct <= 0) return null;
      return milestoneHoldout(eventId, attendeeId, pct) ? 0 : 1;
    };

    // Nombres y correos de los asistentes
    const docs = attendeeIds.length
      ? await this.orgAttendeeModel
          .find({ _id: { $in: attendeeIds } }, { name: 1, email: 1 })
          .lean()
      : [];
    const info = new Map(
      docs.map((d) => [
        String(d._id),
        { name: String(d.name ?? ''), email: String(d.email ?? '') },
      ]),
    );

    // visits: [índice del evento, minutos en vivo, hasta el final (1/0),
    // estado, saludo (GreetingVisit) o null si no hay registros de saludo,
    // mensajes personales mostrados (null si el evento no tiene registro),
    // sorteo de anuncios y sorteo de logros (1 · 0 control · null)]
    const outAttendees = [...visitsByAttendee.entries()].map(
      ([id, byEvent]) => ({
        id,
        name: info.get(id)?.name ?? '',
        email: info.get(id)?.email ?? '',
        groupKey: groupOf.get(id)?.key ?? null,
        group: groupOf.get(id)?.label ?? null,
        visits: [...byEvent.values()]
          .filter((v) => eventIndex.has(v.eventId))
          .map((v) => {
            const endedAt = endedAtOf.get(v.eventId) ?? null;
            const untilEnd = stayedUntilEnd(v.lastSeen, endedAt) ? 1 : 0;
            return [
              eventIndex.get(v.eventId)!,
              round1(v.liveMin),
              untilEnd,
              exposure(v.eventId, id),
              greetOf.get(`${v.eventId}:${id}`) ?? null,
              hasDeliveries.has(v.eventId)
                ? (privateShown.get(`${v.eventId}:${id}`) ?? 0)
                : null,
              herdArm(v.eventId, id),
              milestoneArm(v.eventId, id),
            ] as [
              number,
              number,
              number,
              ExposureStatus,
              GreetingVisit | null,
              number | null,
              Arm,
              Arm,
            ];
          })
          .sort((a, b) => a[0] - b[0]),
      }),
    );

    return { events: outEvents, attendees: outAttendees };
  }
}
