/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as admin from 'firebase-admin';
import {
  Event,
  EventDocument,
  EventMilestonesConfig,
  MilestoneDef,
  MilestoneType,
} from './schemas/event.schema';
import { MilestoneAward } from './schemas/milestone-award.schema';
import { Poll } from './schemas/poll.schema';
import { HerdGreeting } from './schemas/herd-greeting.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { EventUser } from './schemas/event-user.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { RtdbService } from '../rtdb/rtdb.service';
import { HerdService, HerdMember } from './herd.service';
import { UpdateMilestonesConfigDto } from './dtos/update-milestones-config.dto';

/** Textos por defecto de cada tipo de hito */
export const DEFAULT_MILESTONE_TEXTS: Record<
  MilestoneType,
  { private: string; public: string }
> = {
  watchMinutes: {
    private:
      '¡{nombre}, llevas {umbral} minutos seguidos con nosotros! Gracias por acompañarnos',
    public:
      '¡Felicitamos a {nombres} por {umbral} minutos seguidos con nosotros!',
  },
  pollsAnswered: {
    private:
      '¡{nombre}, ya respondiste {umbral} encuestas! Gracias por participar',
    public: '¡{nombres} ya {respondió|respondieron} {umbral} encuestas!',
  },
  pollFirst: {
    private:
      '¡{nombre}, fuiste de los primeros {umbral} en responder la encuesta!',
    public: '¡{nombres} {fue|fueron} de los primeros en responder la encuesta!',
  },
  greetingsSent: {
    private: '¡{nombre}, ya saludaste a tus colegas {umbral} veces!',
    public: '¡{nombres} {está|están} animando la conversación con sus colegas!',
  },
  totalMinutes: {
    private:
      '¡{nombre}, ya sumas {umbral} minutos con nosotros! Gracias por acompañarnos',
    public: '¡{nombres} ya {suma|suman} {umbral} minutos con nosotros!',
  },
  firstToConnect: {
    private:
      '¡{nombre}, fuiste de las primeras {umbral} personas en conectarte! Gracias por llegar temprano',
    public: '¡Gracias a {nombres} por estar entre los primeros en conectarse!',
  },
  frequentAttendee: {
    private:
      '¡{nombre}, este es tu evento número {valor} con nosotros! Gracias por tu fidelidad',
    public: '¡{nombres} ya nos {ha|han} acompañado en {umbral} o más eventos!',
  },
  manual: {
    private: '¡Felicitaciones, {nombre}!',
    public: '¡Felicitamos a {nombres}!',
  },
};

// Tipos que se evalúan con cada flush de presencia
const PRESENCE_TYPES: MilestoneType[] = [
  'watchMinutes',
  'totalMinutes',
  'firstToConnect',
  'frequentAttendee',
];

export const DEFAULT_MILESTONES_CONFIG = {
  privateMessage: { position: 'top-center', durationSec: 8, label: '¡LOGRO!' },
  publicMessage: {
    position: 'top-center',
    durationSec: 7,
    label: 'FELICITACIONES',
    minIntervalSec: 30,
    maxNames: 3,
  },
} as const;

// Corte tolerado sin romper la racha (recargas, cambios de red)
const STREAK_GAP_MS = 90_000;
const CONFIG_TTL_MS = 15_000;

/** Grupo de control determinista por asistente (estable entre reinicios) */
export function milestoneHoldout(
  eventId: string,
  attendeeId: string,
  holdoutPercent = 0,
): boolean {
  if (holdoutPercent <= 0) return false;
  let h = 0x811c9dc5;
  for (const ch of `${eventId}:${attendeeId}:milestones`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 < holdoutPercent;
}

/** {nombre}, {umbral}, {nombres}, {cantidad} y {singular|plural} según cantidad */
export function renderMilestoneTemplate(
  template: string,
  vars: {
    nombre?: string;
    nombres?: string;
    cantidad?: number;
    umbral: number;
    valor?: number; // lo alcanzado (minutos, encuestas, eventos…)
  },
) {
  const one = (vars.cantidad ?? 1) === 1;
  return template
    .replace(/\{nombre\}/g, vars.nombre ?? '')
    .replace(/\{nombres\}/g, vars.nombres ?? vars.nombre ?? '')
    .replace(/\{cantidad\}/g, String(vars.cantidad ?? 1))
    .replace(/\{umbral\}/g, String(vars.umbral))
    .replace(/\{valor\}/g, String(vars.valor ?? vars.umbral))
    .replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, s: string, p: string) =>
      one ? s : p,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Ana" · "Ana y Carlos" · "Ana, Carlos y Laura" · "Ana, Carlos y 5 colegas más" */
export function joinMilestoneNames(names: string[], max = 3) {
  const n = names.length;
  if (n <= 1) return names[0] ?? '';
  if (n <= max) return `${names.slice(0, -1).join(', ')} y ${names[n - 1]}`;
  const rest = n - max;
  return `${names.slice(0, max).join(', ')} y ${rest} ${rest === 1 ? 'colega' : 'colegas'} más`;
}

/** Primer nombre, sin caracteres raros y corto (se pinta sobre el video) */
const firstName = (s: unknown) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 24) ?? '';

type Ctx = {
  config: EventMilestonesConfig;
  items: MilestoneDef[]; // solo los activos
  live: boolean;
  loadedAt: number;
};

type Candidate = {
  item: MilestoneDef;
  attendeeId: string;
  uids: string[];
  value: number;
};

type State = {
  // Racha de conexión por asistente
  streaks: Map<string, { since: number; lastSeen: number }>;
  streaksLoaded: boolean;
  // `${milestoneId}:${attendeeId}` ya otorgados
  awarded: Set<string>;
  awardedLoaded: boolean;
  // Felicitaciones públicas pendientes, por hito (en orden de llegada)
  publicQueue: Map<string, Array<{ attendeeId: string; name: string }>>;
  lastPublicAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Conectados en el último flush (para el logro manual): asistente → uids
  connected: Map<string, string[]>;
  // Historial del evento desde Mongo (minutos totales y orden de llegada)
  history: Map<string, { liveMs: number; firstAt: number }> | null;
  // Último latido contado para los minutos totales
  lastTick: Map<string, number>;
  // Asistentes a los que ya se les contó cuántos eventos lleva
  frequentChecked: Map<string, number>;
};

/**
 * Logros del asistente. Cada evento define sus hitos (tipo + umbral +
 * entrega) en `milestonesConfig`; al cumplir uno se registra en
 * `milestone_awards` (una vez por asistente y hito) y se le felicita:
 *
 * - privado: /milestones/{eventId}/private/{uid}/{id} = { milestoneId, text, at }
 * - público: /milestones/{eventId}/public = { milestoneId, text, count, at },
 *   agrupando a quienes lo cumplieron en la misma ventana ("Ana, Carlos y 5
 *   colegas más") y separando los anuncios minIntervalSec.
 *
 * Señales: presencia (ViewingMetricsService, cada flush), respuestas de
 * encuestas (PollService) y saludos enviados (HerdGreetingService). Ninguna
 * llamada lanza: un error aquí no puede romper métricas, encuestas ni saludos.
 */
@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);
  private contexts = new Map<string, Ctx>();
  private states = new Map<string, State>();
  private chains = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(MilestoneAward.name)
    private awardModel: Model<MilestoneAward>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    @InjectModel(Poll.name) private pollModel: Model<Poll>,
    @InjectModel(HerdGreeting.name)
    private greetingModel: Model<HerdGreeting>,
    private rtdb: RtdbService,
    private herd: HerdService,
    @InjectModel(ViewingSession.name)
    private viewingSessionModel?: Model<ViewingSession>,
    @InjectModel(EventUser.name)
    private eventUserModel?: Model<EventUser>,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  async updateConfig(eventId: string, dto: UpdateMilestonesConfigDto) {
    const event = await this.eventModel.findById(eventId, { _id: 1 }).lean();
    if (!event) throw new NotFoundException('Event not found');

    const seen = new Set<string>();
    const items: MilestoneDef[] = [];
    for (const i of dto.items ?? []) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      items.push({
        id: i.id,
        enabled: i.enabled !== false,
        type: i.type,
        threshold: i.threshold,
        delivery: i.delivery,
        privateTemplate: i.privateTemplate?.trim() || undefined,
        publicTemplate: i.publicTemplate?.trim() || undefined,
      });
    }
    const milestonesConfig: EventMilestonesConfig = {
      enabled: dto.enabled,
      holdoutPercent: dto.holdoutPercent ?? 0,
      accentColor: dto.accentColor || undefined,
      privateMessage: {
        ...DEFAULT_MILESTONES_CONFIG.privateMessage,
        ...(dto.privateMessage ?? {}),
      },
      publicMessage: {
        ...DEFAULT_MILESTONES_CONFIG.publicMessage,
        ...(dto.publicMessage ?? {}),
      },
      items,
    };

    const updated = await this.eventModel
      .findByIdAndUpdate(eventId, { $set: { milestonesConfig } }, { new: true })
      .lean();
    this.contexts.delete(eventId);
    await this.mirrorConfig(eventId, milestonesConfig).catch((e: Error) =>
      this.logger.error(
        `No se pudo espejar milestonesConfig ${eventId}: ${e.message}`,
      ),
    );
    return updated;
  }

  /** Lo que el asistente necesita para pintar las felicitaciones */
  private async mirrorConfig(eventId: string, cfg: EventMilestonesConfig) {
    await this.rtdb.ref(`/milestones/${eventId}/config`).set(
      JSON.parse(
        JSON.stringify({
          enabled: cfg.enabled && cfg.items.some((i) => i.enabled !== false),
          accentColor: cfg.accentColor,
          privateMessage: cfg.privateMessage,
          publicMessage: cfg.publicMessage,
          updatedAt: Date.now(),
        }),
      ),
    );
  }

  private async getContext(eventId: string, force = false) {
    const cached = this.contexts.get(eventId);
    if (!force && cached && Date.now() - cached.loadedAt < CONFIG_TTL_MS) {
      return cached;
    }
    const ev = await this.eventModel
      .findById(eventId, { milestonesConfig: 1, status: 1 })
      .lean();
    if (!ev) return null;
    const config: EventMilestonesConfig = ev.milestonesConfig ?? {
      enabled: false,
      items: [],
    };
    const ctx: Ctx = {
      config,
      items: config.enabled
        ? (config.items ?? []).filter((i) => i.enabled !== false)
        : [],
      live: ev.status === 'live',
      loadedAt: Date.now(),
    };
    this.contexts.set(eventId, ctx);
    return ctx;
  }

  private state(eventId: string): State {
    let s = this.states.get(eventId);
    if (!s) {
      s = {
        streaks: new Map(),
        streaksLoaded: false,
        awarded: new Set(),
        awardedLoaded: false,
        publicQueue: new Map(),
        lastPublicAt: 0,
        timer: null,
        connected: new Map(),
        history: null,
        lastTick: new Map(),
        frequentChecked: new Map(),
      };
      this.states.set(eventId, s);
    }
    return s;
  }

  /** Serializa el trabajo de cada evento y no deja escapar errores */
  private run(eventId: string, label: string, fn: () => Promise<void>) {
    const prev = this.chains.get(eventId) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((e: Error) =>
        this.logger.error(`Milestones ${label} ${eventId}: ${e.message}`),
      );
    this.chains.set(eventId, next);
    void next.finally(() => {
      if (this.chains.get(eventId) === next) this.chains.delete(eventId);
    });
    return next;
  }

  // ── Señales ──────────────────────────────────────────────────────────────

  /**
   * Cada flush de presencia: actualiza la racha de cada asistente conectado
   * y otorga los hitos de minutos seguidos. Fuera del vivo no cuenta (y la
   * racha se reinicia: solo vale el tiempo con el evento en vivo).
   */
  onPresence(eventId: string, members: HerdMember[], isLive: boolean) {
    return this.run(eventId, 'presence', async () => {
      if (!isLive) {
        const s = this.states.get(eventId);
        if (s) {
          s.streaks.clear();
          s.publicQueue.clear();
          s.lastTick.clear();
          s.connected = new Map();
        }
        return;
      }
      const ctx = await this.getContext(eventId);
      const uidsOf = new Map<string, string[]>();
      for (const m of members) {
        const list = uidsOf.get(m.attendeeId) ?? [];
        list.push(m.uid);
        uidsOf.set(m.attendeeId, list);
      }
      const items = (ctx?.items ?? []).filter((i) =>
        PRESENCE_TYPES.includes(i.type),
      );
      const hasManual = (ctx?.items ?? []).some((i) => i.type === 'manual');
      if (!items.length && !hasManual) return;

      const s = this.state(eventId);
      s.connected = uidsOf;
      if (!items.length) return;
      const now = Date.now();
      const of = (t: MilestoneType) => items.filter((i) => i.type === t);
      const candidates: Candidate[] = [];

      if (of('watchMinutes').length) {
        await this.trackStreaks(eventId, s, uidsOf, now);
        for (const [attendeeId, uids] of uidsOf) {
          const minutes = Math.floor(
            (now - s.streaks.get(attendeeId)!.since) / 60_000,
          );
          for (const item of of('watchMinutes')) {
            if (minutes >= item.threshold) {
              candidates.push({ item, attendeeId, uids, value: minutes });
            }
          }
        }
      }

      if (of('totalMinutes').length || of('firstToConnect').length) {
        const history = await this.loadHistory(eventId, s);
        // Minutos totales: lo que ya había en Mongo + lo contado desde entonces
        for (const attendeeId of uidsOf.keys()) {
          const h = history.get(attendeeId) ?? { liveMs: 0, firstAt: now };
          history.set(attendeeId, h);
          const last = s.lastTick.get(attendeeId);
          if (last !== undefined)
            h.liveMs += Math.min(now - last, STREAK_GAP_MS);
          s.lastTick.set(attendeeId, now);
        }
        for (const [attendeeId, uids] of uidsOf) {
          const minutes = Math.floor(history.get(attendeeId)!.liveMs / 60_000);
          for (const item of of('totalMinutes')) {
            if (minutes >= item.threshold) {
              candidates.push({ item, attendeeId, uids, value: minutes });
            }
          }
        }
        // Primeros en conectarse: orden por la primera conexión al evento
        const first = of('firstToConnect');
        if (first.length) {
          const max = Math.max(...first.map((i) => i.threshold));
          const order = [...history.entries()]
            .sort(([, a], [, b]) => a.firstAt - b.firstAt)
            .slice(0, max)
            .map(([id]) => id);
          order.forEach((attendeeId, idx) => {
            const uids = uidsOf.get(attendeeId);
            if (!uids) return; // se felicita cuando esté conectado en vivo
            for (const item of first) {
              if (idx + 1 <= item.threshold) {
                candidates.push({ item, attendeeId, uids, value: idx + 1 });
              }
            }
          });
        }
      }

      if (of('frequentAttendee').length) {
        const counts = await this.eventsAttended(eventId, s, [
          ...uidsOf.keys(),
        ]);
        for (const [attendeeId, uids] of uidsOf) {
          const n = counts.get(attendeeId) ?? 1;
          for (const item of of('frequentAttendee')) {
            if (n >= item.threshold) {
              candidates.push({ item, attendeeId, uids, value: n });
            }
          }
        }
      }

      await this.award(eventId, ctx!, candidates);
    });
  }

  /** Racha de conexión de cada conectado (corte > STREAK_GAP_MS = racha nueva) */
  private async trackStreaks(
    eventId: string,
    s: State,
    uidsOf: Map<string, string[]>,
    now: number,
  ) {
    await this.loadStreaks(eventId, s);
    const started: Record<string, number> = {};
    for (const attendeeId of uidsOf.keys()) {
      const st = s.streaks.get(attendeeId);
      if (!st || now - st.lastSeen > STREAK_GAP_MS) {
        s.streaks.set(attendeeId, { since: now, lastSeen: now });
        started[attendeeId] = now;
      } else {
        st.lastSeen = now;
      }
    }
    // Persistir el inicio de cada racha: sobrevive a un reinicio del API
    if (Object.keys(started).length) {
      await this.rtdb
        .ref(`/milestones/${eventId}/streaks`)
        .update(started)
        .catch(() => {});
    }
  }

  /**
   * Minutos en vivo ya acumulados y primera conexión de cada asistente, desde
   * las sesiones de visualización (sobrevive a reinicios del API). Se lee una
   * vez por evento; después se suma en memoria con cada flush.
   */
  private async loadHistory(eventId: string, s: State) {
    if (s.history) return s.history;
    const history = new Map<string, { liveMs: number; firstAt: number }>();
    s.history = history;
    if (!this.viewingSessionModel || !this.eventUserModel) return history;
    const [rows, eventUsers] = await Promise.all([
      this.viewingSessionModel.aggregate<{
        _id: unknown;
        live: number;
        first: Date;
      }>([
        { $match: { eventId } },
        {
          $group: {
            _id: '$eventUserId',
            live: { $sum: '$liveWatchTimeSeconds' },
            first: { $min: '$startedAt' },
          },
        },
      ]),
      this.eventUserModel.find({ eventId }, { _id: 1, attendeeId: 1 }).lean(),
    ]);
    const attendeeOf = new Map(
      eventUsers.map((eu) => [String(eu._id), String(eu.attendeeId)]),
    );
    for (const r of rows) {
      const attendeeId = attendeeOf.get(String(r._id));
      if (!attendeeId) continue;
      const prev = history.get(attendeeId);
      const firstAt = r.first ? new Date(r.first).getTime() : Date.now();
      history.set(attendeeId, {
        liveMs: (prev?.liveMs ?? 0) + (r.live ?? 0) * 1000,
        firstAt: Math.min(prev?.firstAt ?? Infinity, firstAt),
      });
    }
    return history;
  }

  /**
   * Eventos de la organización a los que asistió cada uno, contando este
   * (OrgAttendee es por organización). Se consulta una vez por asistente.
   */
  private async eventsAttended(
    eventId: string,
    s: State,
    attendeeIds: string[],
  ) {
    const pending = attendeeIds.filter(
      (id) => !s.frequentChecked.has(id) && Types.ObjectId.isValid(id),
    );
    if (pending.length && this.eventUserModel) {
      const rows = await this.eventUserModel.aggregate<{
        _id: unknown;
        n: number;
      }>([
        {
          $match: {
            attendeeId: { $in: pending.map((id) => new Types.ObjectId(id)) },
            eventId: { $ne: eventId },
            status: 'attended',
          },
        },
        { $group: { _id: '$attendeeId', n: { $sum: 1 } } },
      ]);
      const others = new Map(rows.map((r) => [String(r._id), r.n]));
      for (const id of pending)
        s.frequentChecked.set(id, (others.get(id) ?? 0) + 1);
    }
    return s.frequentChecked;
  }

  // ── Logro manual ─────────────────────────────────────────────────────────

  /** Conectados ahora (para elegir a quién felicitar), con sus logros manuales */
  async connected(eventId: string) {
    const s = this.states.get(eventId);
    const ids = [...(s?.connected.keys() ?? [])].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (!ids.length) return [];
    const [docs, awards] = await Promise.all([
      this.orgAttendeeModel
        .find({ _id: { $in: ids } }, { name: 1, email: 1 })
        .lean(),
      this.awardModel
        .find(
          { eventId, attendeeId: { $in: ids }, type: 'manual' },
          { attendeeId: 1, milestoneId: 1 },
        )
        .lean(),
    ]);
    const got = new Map<string, string[]>();
    for (const a of awards) {
      got.set(a.attendeeId, [...(got.get(a.attendeeId) ?? []), a.milestoneId]);
    }
    return docs
      .map((d) => ({
        attendeeId: String(d._id),
        name: String(d.name ?? ''),
        email: String(d.email ?? ''),
        awarded: got.get(String(d._id)) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  /** El admin felicita a uno o varios asistentes con un hito manual */
  async awardManual(
    eventId: string,
    milestoneId: string,
    attendeeIds: string[],
  ) {
    const ctx = await this.getContext(eventId, true);
    if (!ctx) throw new NotFoundException('Event not found');
    if (!ctx.live) {
      throw new BadRequestException(
        'Las felicitaciones solo se muestran con el evento en vivo',
      );
    }
    const item = ctx.items.find(
      (i) => i.id === milestoneId && i.type === 'manual',
    );
    if (!item) {
      throw new BadRequestException(
        'Ese logro manual no existe o está desactivado',
      );
    }
    const s = this.state(eventId);
    await this.loadAwarded(eventId, s);
    const ids = [...new Set(attendeeIds)];
    const already = ids.filter((id) => s.awarded.has(`${item.id}:${id}`));
    await this.run(eventId, 'manual', () =>
      this.award(
        eventId,
        ctx,
        ids.map((attendeeId) => ({
          item,
          attendeeId,
          uids: s.connected.get(attendeeId) ?? [],
          value: 1,
        })),
      ),
    );
    return { awarded: ids.length - already.length, already: already.length };
  }

  /** Respuesta a una encuesta: hitos de encuestas respondidas y de primeros en responder */
  onPollResponse(
    eventId: string,
    attendeeId: string,
    uid: string,
    position: number,
  ) {
    return this.run(eventId, 'poll', async () => {
      const ctx = await this.getContext(eventId);
      if (!ctx?.live) return;
      const items = ctx.items.filter(
        (i) => i.type === 'pollsAnswered' || i.type === 'pollFirst',
      );
      if (!items.length) return;

      let answered = 0;
      if (items.some((i) => i.type === 'pollsAnswered')) {
        answered = await this.pollModel.countDocuments({
          eventId: Types.ObjectId.isValid(eventId)
            ? new Types.ObjectId(eventId)
            : eventId,
          'responses.orgAttendeeId': attendeeId,
        });
      }
      const candidates: Candidate[] = [];
      for (const item of items) {
        if (item.type === 'pollsAnswered' && answered >= item.threshold) {
          candidates.push({ item, attendeeId, uids: [uid], value: answered });
        }
        if (item.type === 'pollFirst' && position <= item.threshold) {
          candidates.push({ item, attendeeId, uids: [uid], value: position });
        }
      }
      await this.award(eventId, ctx, candidates);
    });
  }

  /** Saludo enviado a colegas (anuncios de manada) */
  onGreetingSent(eventId: string, attendeeId: string, uid: string) {
    return this.run(eventId, 'greeting', async () => {
      const ctx = await this.getContext(eventId);
      if (!ctx?.live) return;
      const items = ctx.items.filter((i) => i.type === 'greetingsSent');
      if (!items.length) return;
      const sent = await this.greetingModel.countDocuments({
        eventId,
        kind: 'greet',
        attendeeId,
      });
      await this.award(
        eventId,
        ctx,
        items
          .filter((i) => sent >= i.threshold)
          .map((item) => ({ item, attendeeId, uids: [uid], value: sent })),
      );
    });
  }

  // ── Otorgar y felicitar ──────────────────────────────────────────────────

  private async loadStreaks(eventId: string, s: State) {
    if (s.streaksLoaded) return;
    s.streaksLoaded = true;
    const snap = await this.rtdb
      .ref(`/milestones/${eventId}/streaks`)
      .once('value')
      .catch(() => null);
    const saved = (snap?.val() ?? {}) as Record<string, number>;
    const now = Date.now();
    for (const [attendeeId, since] of Object.entries(saved)) {
      if (typeof since === 'number' && !s.streaks.has(attendeeId)) {
        // Si no vuelve a aparecer en STREAK_GAP_MS, la racha se reinicia
        s.streaks.set(attendeeId, { since, lastSeen: now });
      }
    }
  }

  private async loadAwarded(eventId: string, s: State) {
    if (s.awardedLoaded) return;
    const docs = await this.awardModel
      .find({ eventId }, { milestoneId: 1, attendeeId: 1 })
      .lean();
    for (const d of docs) s.awarded.add(`${d.milestoneId}:${d.attendeeId}`);
    s.awardedLoaded = true;
  }

  private async award(eventId: string, ctx: Ctx, candidates: Candidate[]) {
    if (!candidates.length) return;
    const s = this.state(eventId);
    await this.loadAwarded(eventId, s);
    const fresh = candidates.filter(
      (c) => !s.awarded.has(`${c.item.id}:${c.attendeeId}`),
    );
    if (!fresh.length) return;
    for (const c of fresh) s.awarded.add(`${c.item.id}:${c.attendeeId}`);

    // Nombres y tratamiento formal (como en los anuncios de manada)
    const ids = [...new Set(fresh.map((c) => c.attendeeId))];
    const docs = await this.orgAttendeeModel
      .find(
        {
          _id: {
            $in: ids.filter((id) => Types.ObjectId.isValid(id)),
          },
        },
        { name: 1, registrationData: 1 },
      )
      .lean();
    const titles = await this.herd.formalTitles(eventId, docs);
    const names = new Map<string, string>();
    for (const d of docs) {
      const first = firstName(d.name);
      const title = titles.get(String(d._id));
      names.set(String(d._id), first && title ? `${title} ${first}` : first);
    }

    const holdoutPercent = ctx.config.holdoutPercent ?? 0;
    const privateUpdates: Record<string, unknown> = {};
    const rows: Partial<MilestoneAward>[] = [];
    for (const c of fresh) {
      const name = names.get(c.attendeeId) || 'colega';
      const holdout = milestoneHoldout(eventId, c.attendeeId, holdoutPercent);
      // Sin uid conectado (logro manual a alguien que se fue) no hay a quién avisar
      const sendPrivate =
        !holdout &&
        c.uids.length > 0 &&
        (c.item.delivery === 'private' || c.item.delivery === 'both');
      const sendPublic =
        !holdout &&
        (c.item.delivery === 'public' || c.item.delivery === 'both');

      if (sendPrivate) {
        const text = renderMilestoneTemplate(
          c.item.privateTemplate ||
            DEFAULT_MILESTONE_TEXTS[c.item.type].private,
          { nombre: name, umbral: c.item.threshold, valor: c.value },
        );
        for (const uid of c.uids) {
          const key = this.rtdb
            .ref(`/milestones/${eventId}/private/${uid}`)
            .push().key;
          privateUpdates[`${uid}/${key}`] = {
            milestoneId: c.item.id,
            text,
            at: admin.database.ServerValue.TIMESTAMP,
          };
        }
      }
      if (sendPublic) {
        const queue = s.publicQueue.get(c.item.id) ?? [];
        queue.push({ attendeeId: c.attendeeId, name });
        s.publicQueue.set(c.item.id, queue);
      }
      rows.push({
        eventId,
        milestoneId: c.item.id,
        type: c.item.type,
        threshold: c.item.threshold,
        attendeeId: c.attendeeId,
        uids: sendPrivate ? c.uids : [],
        name,
        value: c.value,
        holdout,
        privateSent: sendPrivate,
      });
    }

    // Duplicados (otra instancia ya lo otorgó) se ignoran por el índice único
    await this.awardModel
      .insertMany(rows, { ordered: false })
      .catch((e: any) => {
        if (e?.code !== 11000 && !e?.writeErrors) throw e;
      });
    if (Object.keys(privateUpdates).length) {
      await this.rtdb
        .ref(`/milestones/${eventId}/private`)
        .update(privateUpdates);
    }
    this.schedulePublic(eventId, ctx);
  }

  /** Saca la felicitación pública pendiente más antigua, respetando el intervalo */
  private schedulePublic(eventId: string, ctx: Ctx) {
    const s = this.state(eventId);
    if (s.timer || !s.publicQueue.size) return;
    const interval =
      (ctx.config.publicMessage?.minIntervalSec ??
        DEFAULT_MILESTONES_CONFIG.publicMessage.minIntervalSec) * 1000;
    const wait = Math.max(0, s.lastPublicAt + interval - Date.now());
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.run(eventId, 'public', async () => {
        await this.flushPublic(eventId);
        const fresh = await this.getContext(eventId);
        if (fresh) this.schedulePublic(eventId, fresh);
      });
    }, wait);
  }

  private async flushPublic(eventId: string) {
    const s = this.states.get(eventId);
    const ctx = await this.getContext(eventId);
    if (!s || !ctx) return;
    // El hito que lleva más tiempo esperando (orden de inserción del Map)
    const milestoneId = s.publicQueue.keys().next().value as string | undefined;
    if (!milestoneId) return;
    const people = s.publicQueue.get(milestoneId) ?? [];
    s.publicQueue.delete(milestoneId);
    const item = ctx.items.find((i) => i.id === milestoneId);
    if (!ctx.live || !item || !people?.length) return;

    const maxNames =
      ctx.config.publicMessage?.maxNames ??
      DEFAULT_MILESTONES_CONFIG.publicMessage.maxNames;
    const text = renderMilestoneTemplate(
      item.publicTemplate || DEFAULT_MILESTONE_TEXTS[item.type].public,
      {
        nombres: joinMilestoneNames(
          people.map((p) => p.name),
          maxNames,
        ),
        cantidad: people.length,
        umbral: item.threshold,
      },
    );
    s.lastPublicAt = Date.now();
    await this.rtdb.ref(`/milestones/${eventId}/public`).set({
      milestoneId,
      text,
      count: people.length,
      at: admin.database.ServerValue.TIMESTAMP,
    });
    await this.awardModel.updateMany(
      {
        eventId,
        milestoneId,
        attendeeId: { $in: people.map((p) => p.attendeeId) },
      },
      { $set: { publicAt: new Date() } },
    );
  }

  // ── Informe ──────────────────────────────────────────────────────────────

  async report(eventId: string) {
    const ctx = await this.getContext(eventId, true);
    if (!ctx) throw new NotFoundException('Event not found');
    const rows: Array<{
      _id: string;
      awarded: number;
      holdout: number;
      privateSent: number;
      publicShown: number;
      first: Date;
      last: Date;
    }> = await this.awardModel.aggregate([
      { $match: { eventId } },
      {
        $group: {
          _id: '$milestoneId',
          awarded: { $sum: 1 },
          holdout: { $sum: { $cond: ['$holdout', 1, 0] } },
          privateSent: { $sum: { $cond: ['$privateSent', 1, 0] } },
          publicShown: {
            $sum: { $cond: [{ $ifNull: ['$publicAt', false] }, 1, 0] },
          },
          first: { $min: '$createdAt' },
          last: { $max: '$createdAt' },
        },
      },
    ]);
    const byId = new Map(rows.map((r) => [r._id, r]));
    const recent = await this.awardModel
      .find(
        { eventId },
        {
          _id: 0,
          milestoneId: 1,
          name: 1,
          value: 1,
          holdout: 1,
          privateSent: 1,
          publicAt: 1,
          createdAt: 1,
        },
      )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return {
      enabled: ctx.config.enabled,
      holdoutPercent: ctx.config.holdoutPercent ?? 0,
      milestones: (ctx.config.items ?? []).map((i) => {
        const r = byId.get(i.id);
        return {
          id: i.id,
          type: i.type,
          threshold: i.threshold,
          delivery: i.delivery,
          enabled: i.enabled !== false,
          awarded: r?.awarded ?? 0,
          holdout: r?.holdout ?? 0,
          privateSent: r?.privateSent ?? 0,
          publicShown: r?.publicShown ?? 0,
          first: r?.first ?? null,
          last: r?.last ?? null,
        };
      }),
      recent,
    };
  }

  /** Libera el estado en memoria de un evento (al apagar su watcher) */
  clearEvent(eventId: string) {
    const s = this.states.get(eventId);
    if (s?.timer) clearTimeout(s.timer);
    this.states.delete(eventId);
    this.contexts.delete(eventId);
  }
}
