/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as admin from 'firebase-admin';
import { Event, EventDocument, EventHerdConfig } from './schemas/event.schema';
import { Organization } from '../organizations/schemas/organization.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { EventUser } from './schemas/event-user.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { RtdbService } from '../rtdb/rtdb.service';
import { UpdateHerdConfigDto } from './dtos/update-herd-config.dto';
import { herdGroupForms } from './herd-grammar';

/**
 * Normaliza un valor del formulario para comparar sin tildes/mayúsculas.
 * IMPORTANTE: el frontend (src/api/herd.ts) replica norm/herdKey; si cambias
 * uno, cambia el otro o el asistente no encontrará su grupo en los conteos.
 */
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

/** Clave segura para RTDB (no admite . # $ / [ ]) */
export const herdKey = (s: unknown) =>
  norm(s)
    .replace(/[.#$/[\]]/g, '_')
    .slice(0, 100) || '_';

export const DEFAULT_HERD_CONFIG: Required<
  Omit<
    EventHerdConfig,
    'fieldId' | 'groupLabels' | 'excludedGroups' | 'holdoutPercent'
  >
> = {
  enabled: false,
  accentColor: '#3b82f6',
  privateMessage: {
    enabled: true,
    template: '¡Hola {nombre}! Contigo ya son {cantidad} {grupo} conectados',
    position: 'top-left',
    durationSec: 8,
    repeatEverySec: 0,
    repeatTemplate: '',
    firstCount: 5,
    firstTemplate:
      '¡Hola {nombre}! Eres la {posicion} persona de {grupo_plural} en conectarse',
    ordinalGender: 'f',
  },
  publicMessage: {
    enabled: true,
    template: '¡Ya son {cantidad} {grupo} conectados!',
    position: 'bottom-left',
    durationSec: 6,
    announceOnGrowth: true,
    minIntervalSec: 20,
    milestoneEvery: 1,
    repeatEverySec: 0,
    repeatTemplate: '',
  },
  greeting: {
    enabled: false,
    position: 'bottom-right',
    durationSec: 6,
    cooldownSec: 60,
    holdoutPercent: 0,
  },
};

/**
 * ¿Este asistente ve el botón «👋 Saludar»? Sorteo determinista por evento y
 * asistente (FNV-1a): no hay que persistirlo y el informe lo recalcula igual.
 */
export function greetingHasButton(
  eventId: string,
  attendeeId: string,
  holdoutPercent = 0,
): boolean {
  if (holdoutPercent <= 0) return true;
  let h = 0x811c9dc5;
  for (const ch of `${eventId}:${attendeeId}:greet`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 >= holdoutPercent;
}

// Repetición mínima: los flushes de presencia llegan cada ~15 s (heartbeats)
const MIN_REPEAT_SEC = 30;

// label = plural ("endocrinólogos"); singular = "endocrinólogo"
type Group = { key: string; label: string; singular: string };

/**
 * Grupo propio publicado en /herd/{eventId}/members/{uid}. muted = no ve
 * ningún mensaje (grupo excluido o grupo de control del experimento)
 */
type MemberEntry = Group & { position?: number; muted?: true; greet?: true };

/** Brazo del experimento: t = ve los mensajes, c = grupo de control */
type Arm = 't' | 'c';

// Quien sigue conectado hasta 5 min antes del fin cuenta como "se quedó hasta el final"
const UNTIL_END_MARGIN_MS = 5 * 60_000;

/** Contexto por evento: config + resolución valor → grupo, con caché */
type HerdContext = {
  config: EventHerdConfig;
  fieldId: string | null;
  resolve: (raw: unknown) => Group | null;
  // Claves de los grupos que no reciben mensajes
  excludedKeys: Set<string>;
  holdoutPercent: number;
  loadedAt: number;
};

/** Estado de los conteos publicados por evento */
type HerdState = {
  countsJson: string;
  // Último conteo calculado (para el anuncio manual desde el admin)
  counts: Record<string, number>;
  labels: Map<string, Group>;
  total: number;
  // Inscritos al evento por grupo ("ya son 12 de 50 inscritos"); se recalcula
  // cada REGISTERED_TTL_MS. registeredAt = 0 → nunca calculado
  registered: Record<string, number>;
  registeredTotal: number;
  registeredAt: number;
  // Último conteo anunciado públicamente por grupo (marca de agua): solo se
  // anuncia al superar este valor, así un asistente que recarga la página no
  // vuelve a disparar "ya son N".
  announced: Map<string, number>;
  lastAnnouncedAt: Map<string, number>;
  lastPublicAt: number;
  // Grupos ya repetidos en la vuelta actual (sorteo sin repetir)
  repeatRound: Set<string>;
  // Inicio del estado: la repetición periódica cuenta desde aquí si aún no
  // hubo anuncio, para no anunciar de golpe al arrancar
  startedAt: number;
  // grupo → (attendeeId → orden de llegada 1, 2, 3…). Se persiste en
  // /herd/{eventId}/arrivals para que un reinicio no repita "eres la primera"
  arrivals: Map<string, Map<string, number>>;
  // attendeeId → brazo del experimento. Se sortea la primera vez que se ve al
  // asistente y se persiste en /herd/{eventId}/arms (no cambia al volver)
  arms: Map<string, Arm>;
  // uid → "clave|posición|muted" publicada en /herd/{eventId}/members (null = sin grupo)
  membersWritten: Map<string, string | null>;
  // UIDs presentes en el flush anterior: los que no estaban acaban de llegar
  activeUids: Set<string>;
};

type CachedGroup = { group: Group | null; at: number };

/** Asistente conectado: UID de Firebase (presencia) + su OrgAttendee */
export type HerdMember = { uid: string; attendeeId: string };

@Injectable()
export class HerdService {
  private readonly logger = new Logger(HerdService.name);

  private readonly CONTEXT_TTL_MS = 30_000;
  private contexts = new Map<string, HerdContext>();
  // eventId → (attendeeId → grupo). Se relee al llegar el asistente y, mientras
  // sigue conectado, cada GROUP_TTL_MS: así se refleja si actualiza su registro.
  private attendeeGroups = new Map<string, Map<string, CachedGroup>>();
  private readonly GROUP_TTL_MS = 2 * 60_000;
  private readonly REGISTERED_TTL_MS = 60_000;
  private states = new Map<string, HerdState>();
  // Serializa el procesamiento por evento (flushes solapados del watcher)
  private chains = new Map<string, Promise<void>>();
  // Eventos en diferido: la página del asistente no pinta la manada, así que
  // no se cuenta, no se sortea ni se anuncia (ensuciaría el experimento)
  private replayEvents = new Set<string>();

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(Organization.name) private orgModel: Model<Organization>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    private rtdb: RtdbService,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(ViewingSession.name)
    private viewingSessionModel?: Model<ViewingSession>,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  async updateConfig(eventId: string, dto: UpdateHerdConfigDto) {
    const event = await this.eventModel.findById(eventId).lean();
    if (!event) throw new NotFoundException('Event not found');

    const herdConfig: EventHerdConfig = {
      enabled: dto.enabled,
      fieldId: dto.fieldId || undefined,
      groupLabels: (dto.groupLabels ?? []).filter(
        (g) => g.label?.trim() || g.singular?.trim(),
      ),
      excludedGroups: [...new Set(dto.excludedGroups ?? [])],
      holdoutPercent: dto.holdoutPercent ?? 0,
      accentColor: dto.accentColor || DEFAULT_HERD_CONFIG.accentColor,
      privateMessage: {
        ...DEFAULT_HERD_CONFIG.privateMessage,
        ...(dto.privateMessage ?? {}),
      },
      publicMessage: {
        ...DEFAULT_HERD_CONFIG.publicMessage,
        ...(dto.publicMessage ?? {}),
      },
      greeting: {
        ...DEFAULT_HERD_CONFIG.greeting,
        ...(dto.greeting ?? {}),
      },
    };

    const updated = await this.eventModel
      .findByIdAndUpdate(eventId, { $set: { herdConfig } }, { new: true })
      .lean();

    // Invalida cachés: el campo o las etiquetas pueden haber cambiado
    this.contexts.delete(eventId);
    this.attendeeGroups.delete(eventId);
    this.states.delete(eventId);
    await this.rtdb
      .ref(`/herd/${eventId}/members`)
      .remove()
      .catch(() => {});

    await this.mirrorConfig(eventId).catch((e: Error) =>
      this.logger.error(
        `No se pudo espejar herdConfig ${eventId}: ${e.message}`,
      ),
    );

    return updated;
  }

  /**
   * Espeja en RTDB (/herd/{eventId}/config) lo que el asistente necesita para
   * pintar los mensajes sin pasar por Mongo, incluida la tabla de grupos para
   * ubicar su propio valor del formulario.
   */
  async mirrorConfig(eventId: string) {
    const ctx = await this.getContext(eventId, true);
    if (!ctx) return;
    const field = await this.getField(eventId, ctx.config.fieldId);
    const labels = this.labelOverrides(ctx.config);

    const groups = (
      (field?.options ?? []) as Array<{
        value: string;
        label: string;
      }>
    ).map((o) => {
      const forms = herdGroupForms(
        labels.get(String(o.value)),
        String(o.label ?? o.value),
      );
      return {
        key: herdKey(o.value),
        value: String(o.value),
        optionLabel: String(o.label ?? o.value),
        label: forms.plural,
        singular: forms.singular,
        ...(ctx.excludedKeys.has(herdKey(o.value)) ? { excluded: true } : {}),
      };
    });

    const { enabled, accentColor, privateMessage, publicMessage } = ctx.config;
    const greeting = {
      ...DEFAULT_HERD_CONFIG.greeting,
      ...(ctx.config.greeting ?? {}),
    };
    await this.rtdb.ref(`/herd/${eventId}/config`).set(
      JSON.parse(
        JSON.stringify({
          enabled: !!enabled && !!ctx.fieldId,
          fieldId: ctx.fieldId,
          accentColor,
          privateMessage,
          publicMessage,
          greeting,
          groups,
          holdoutPercent: ctx.holdoutPercent,
          updatedAt: Date.now(),
        }),
      ),
    );
  }

  /** Formas escritas por el admin para cada opción (plural y/o singular) */
  private labelOverrides(config: EventHerdConfig) {
    return new Map(
      (config.groupLabels ?? []).map((g) => [String(g.value), g] as const),
    );
  }

  private async getField(eventId: string, fieldId?: string) {
    if (!fieldId) return null;
    const event = await this.eventModel.findById(eventId, { orgId: 1 }).lean();
    if (!event) return null;
    const org = await this.orgModel
      .findById(event.orgId, { 'registrationForm.fields': 1 })
      .lean();
    const fields: any[] = (org as any)?.registrationForm?.fields ?? [];
    return fields.find((f) => f?.id === fieldId) ?? null;
  }

  private async getContext(
    eventId: string,
    force = false,
  ): Promise<HerdContext | null> {
    const cached = this.contexts.get(eventId);
    if (
      !force &&
      cached &&
      Date.now() - cached.loadedAt < this.CONTEXT_TTL_MS
    ) {
      return cached;
    }

    const event = await this.eventModel
      .findById(eventId, { herdConfig: 1 })
      .lean();
    if (!event) return null;
    const config: EventHerdConfig = event.herdConfig ?? { enabled: false };
    const field = await this.getField(eventId, config.fieldId);
    const labels = this.labelOverrides(config);

    // Un registro puede haber guardado el VALOR de la opción o su ETIQUETA:
    // ambos se canonizan a la misma opción (igual que en el reporte).
    const byNorm = new Map<string, { value: string; label: string }>();
    for (const o of (field?.options ?? []) as Array<{
      value: string;
      label: string;
    }>) {
      const opt = { value: String(o.value), label: String(o.label ?? o.value) };
      byNorm.set(norm(o.label), opt);
      byNorm.set(norm(o.value), opt);
    }

    const resolve = (raw: unknown): Group | null => {
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (v == null || typeof v === 'object' || !String(v).trim()) return null;
      const opt = byNorm.get(norm(v));
      if (opt) {
        const forms = herdGroupForms(labels.get(opt.value), opt.label);
        return {
          key: herdKey(opt.value),
          label: forms.plural,
          singular: forms.singular,
        };
      }
      // Campo de texto libre (o valor fuera de las opciones): agrupa por texto normalizado
      const text = String(v).trim();
      return { key: herdKey(v), label: text, singular: text };
    };

    const prevFieldId = cached?.fieldId ?? null;
    const ctx: HerdContext = {
      config,
      fieldId: field ? String(field.id) : null,
      resolve,
      excludedKeys: new Set((config.excludedGroups ?? []).map(herdKey)),
      holdoutPercent: Math.min(90, Math.max(0, config.holdoutPercent ?? 0)),
      loadedAt: Date.now(),
    };
    if (prevFieldId !== ctx.fieldId) this.attendeeGroups.delete(eventId);
    this.contexts.set(eventId, ctx);
    return ctx;
  }

  // ── Conteos en tiempo real ───────────────────────────────────────────────

  /**
   * Llamado por ViewingMetricsService en cada flush de presencia con los
   * asistentes activos (registrados) del evento. No lanza: los errores se
   * registran para no afectar las métricas. Con `isReplay` no hace nada.
   */
  onActiveAttendees(
    eventId: string,
    members: HerdMember[],
    isReplay = false,
  ): Promise<void> {
    if (isReplay) {
      this.replayEvents.add(eventId);
      return Promise.resolve();
    }
    this.replayEvents.delete(eventId);
    const prev = this.chains.get(eventId) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(eventId, members))
      .catch((e: Error) =>
        this.logger.error(`Herd flush error ${eventId}: ${e.message}`),
      );
    this.chains.set(eventId, next);
    void next.finally(() => {
      if (this.chains.get(eventId) === next) this.chains.delete(eventId);
    });
    return next;
  }

  private async process(eventId: string, members: HerdMember[]) {
    const ctx = await this.getContext(eventId);
    if (!ctx?.config.enabled || !ctx.fieldId) return;

    // Una persona con varias pestañas cuenta una vez
    const attendeeIds = [...new Set(members.map((m) => m.attendeeId))];

    const isFirst = !this.states.has(eventId);
    const state: HerdState = this.states.get(eventId) ?? {
      countsJson: '',
      announced: new Map(),
      lastAnnouncedAt: new Map(),
      lastPublicAt: 0,
      repeatRound: new Set(),
      startedAt: Date.now(),
      arrivals: await this.loadArrivals(eventId),
      arms: await this.loadArms(eventId),
      membersWritten: new Map(),
      activeUids: new Set(),
      counts: {},
      labels: new Map(),
      total: 0,
      registered: {},
      registeredTotal: 0,
      registeredAt: 0,
    };
    this.states.set(eventId, state);

    // Quien acaba de entrar (o volver) se relee de Mongo: pudo haber
    // actualizado su registro desde la última vez.
    const arrived = new Set(
      members
        .filter((m) => !state.activeUids.has(m.uid))
        .map((m) => m.attendeeId),
    );
    state.activeUids = new Set(members.map((m) => m.uid));

    const groups = await this.resolveGroups(eventId, ctx, attendeeIds, arrived);

    const counts: Record<string, number> = {};
    const labels = new Map<string, Group>();
    for (const id of attendeeIds) {
      const g = groups.get(id);
      if (!g) continue;
      counts[g.key] = (counts[g.key] ?? 0) + 1;
      labels.set(g.key, g);
    }
    const total = attendeeIds.length;

    // Orden de llegada dentro de cada grupo: se asigna la primera vez que se
    // ve al asistente en ese grupo y no cambia aunque salga y vuelva.
    const arrivalUpdates: Record<string, number> = {};
    for (const id of attendeeIds) {
      const g = groups.get(id);
      if (!g) continue;
      const order = state.arrivals.get(g.key) ?? new Map<string, number>();
      state.arrivals.set(g.key, order);
      if (order.has(id)) continue;
      order.set(id, order.size + 1);
      arrivalUpdates[`${g.key}/${id}`] = order.size;
    }
    if (Object.keys(arrivalUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/arrivals`).update(arrivalUpdates);
    }

    // Sorteo del experimento: cada asistente con grupo cae una sola vez en
    // control (no ve mensajes) o tratamiento, con la probabilidad configurada
    const armUpdates: Record<string, Arm> = {};
    for (const id of attendeeIds) {
      if (!groups.get(id) || state.arms.has(id)) continue;
      const arm: Arm = Math.random() * 100 < ctx.holdoutPercent ? 'c' : 't';
      state.arms.set(id, arm);
      armUpdates[id] = arm;
    }
    if (Object.keys(armUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/arms`).update(armUpdates);
    }

    // Grupo propio de cada asistente (y su orden de llegada), para su mensaje
    // privado: así la página no depende de tener el registrationData (según
    // cómo inició sesión puede no tenerlo). Solo se escribe al llegar o si su
    // grupo cambió.
    const memberUpdates: Record<string, MemberEntry | null> = {};
    for (const m of members) {
      const g = groups.get(m.attendeeId) ?? null;
      const position = g
        ? state.arrivals.get(g.key)?.get(m.attendeeId)
        : undefined;
      const muted = !!g && this.isMuted(ctx, state, m.attendeeId, g.key);
      // Botón «👋 Saludar» en su anuncio individual (saludo activo y en el
      // brazo con botón del experimento del saludo)
      const greet =
        !!g &&
        !muted &&
        !!ctx.config.greeting?.enabled &&
        greetingHasButton(
          eventId,
          m.attendeeId,
          ctx.config.greeting?.holdoutPercent ?? 0,
        );
      const entry: MemberEntry | null = g
        ? {
            ...g,
            ...(position ? { position } : {}),
            ...(muted ? { muted: true as const } : {}),
            ...(greet ? { greet: true as const } : {}),
          }
        : null;
      const written = g
        ? `${g.key}|${position ?? ''}|${muted ? 1 : 0}|${greet ? 1 : 0}`
        : null;
      if (
        state.membersWritten.has(m.uid) &&
        state.membersWritten.get(m.uid) === written
      ) {
        continue;
      }
      state.membersWritten.set(m.uid, written);
      memberUpdates[m.uid] = entry;
    }
    if (Object.keys(memberUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/members`).update(memberUpdates);
    }

    state.counts = counts;
    state.labels = labels;
    state.total = total;

    await this.refreshRegistered(eventId, ctx, state);
    const { registered, registeredTotal } = state;

    const countsJson = JSON.stringify({
      counts,
      total,
      registered,
      registeredTotal,
    });
    if (countsJson !== state.countsJson) {
      state.countsJson = countsJson;
      await this.rtdb.ref(`/herd/${eventId}/live`).set({
        counts,
        total,
        registered,
        registeredTotal,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });
    }

    const pub = {
      ...DEFAULT_HERD_CONFIG.publicMessage,
      ...(ctx.config.publicMessage ?? {}),
    };

    // Primer flush (arranque del watcher o del proceso): se toma como línea
    // base para no anunciar de golpe a toda la audiencia que ya estaba.
    // Sin anuncio al crecer, la marca de agua sigue al conteo: si luego se
    // activa, no se anuncia de golpe lo acumulado
    const onGrowth = pub.announceOnGrowth !== false;
    if (isFirst || !pub.enabled || !onGrowth) {
      for (const [k, n] of Object.entries(counts)) state.announced.set(k, n);
      if (isFirst || !pub.enabled) return;
    }

    const now = Date.now();
    const every = Math.max(1, pub.milestoneEvery ?? 1);
    // Los grupos excluidos nunca se anuncian
    const announceable = Object.entries(counts).filter(
      ([k]) => !ctx.excludedKeys.has(k),
    );
    const pending = announceable.filter(([k, n]) => {
      const last = state.announced.get(k) ?? 0;
      return n > last && Math.floor(n / every) > Math.floor(last / every);
    });
    const canGrow =
      onGrowth &&
      pending.length > 0 &&
      now - state.lastPublicAt >= (pub.minIntervalSec ?? 20) * 1000;

    // Repetición periódica: sin llegadas nuevas, recuerda el estado actual de
    // algún grupo cada repeatEverySec (contado desde el último anuncio)
    const repeatMs =
      (pub.repeatEverySec ?? 0) > 0
        ? Math.max(MIN_REPEAT_SEC, pub.repeatEverySec!) * 1000
        : 0;
    const repeatDue =
      repeatMs > 0 &&
      now - Math.max(state.lastPublicAt, state.startedAt) >= repeatMs;

    const repeat = !canGrow && repeatDue;
    const candidates = canGrow
      ? pending
      : repeat
        ? announceable.filter(([, n]) => n > 0)
        : [];
    if (!candidates.length) return;

    let key: string;
    let count: number;
    if (repeat) {
      // Repetición: grupo al azar entre los que aún no salieron en esta
      // vuelta; cuando todos salieron, empieza otra vuelta
      let fresh = candidates.filter(([k]) => !state.repeatRound.has(k));
      if (!fresh.length) {
        state.repeatRound.clear();
        fresh = candidates;
      }
      [key, count] = fresh[Math.floor(Math.random() * fresh.length)];
      state.repeatRound.add(key);
    } else {
      // Al crecer: primero el anunciado hace más tiempo; a igualdad, el más grande
      candidates.sort(
        ([ka, na], [kb, nb]) =>
          (state.lastAnnouncedAt.get(ka) ?? 0) -
            (state.lastAnnouncedAt.get(kb) ?? 0) || nb - na,
      );
      [key, count] = candidates[0];
    }
    // Anunciar el hito alcanzado (no el conteo exacto) cuando se usan hitos;
    // la repetición muestra el conteo actual
    const shown =
      !repeat && every > 1 ? Math.floor(count / every) * every : count;

    state.announced.set(key, Math.max(state.announced.get(key) ?? 0, count));
    state.lastAnnouncedAt.set(key, now);
    state.lastPublicAt = now;

    await this.rtdb.ref(`/herd/${eventId}/public`).set({
      key,
      label: labels.get(key)?.label ?? key,
      singular: labels.get(key)?.singular ?? key,
      count: shown,
      total,
      // Nunca menos inscritos que conectados (cambios de grupo, caché)
      registered: Math.max(registered[key] ?? 0, count),
      registeredTotal: Math.max(registeredTotal, total),
      ...(repeat ? { repeat: true } : {}),
      at: admin.database.ServerValue.TIMESTAMP,
    });
  }

  /**
   * Inscritos al evento (sin cancelados) por grupo, con la misma canonización
   * que los conectados. Si falla se conserva el último cálculo.
   */
  private async refreshRegistered(
    eventId: string,
    ctx: HerdContext,
    state: HerdState,
  ) {
    const now = Date.now();
    if (now - state.registeredAt < this.REGISTERED_TTL_MS) return;
    state.registeredAt = now;
    // El id del campo se usa como ruta en la agregación
    if (!ctx.fieldId || !/^[\w-]+$/.test(ctx.fieldId)) return;
    try {
      const rows: Array<{ _id: unknown; n: number }> =
        await this.eventUserModel.aggregate([
          { $match: { eventId, status: { $ne: 'cancelled' } } },
          {
            $lookup: {
              from: this.orgAttendeeModel.collection.name,
              // $toObjectId tolera registros viejos con attendeeId en texto
              let: { aid: { $toObjectId: '$attendeeId' } },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$aid'] } } },
                { $project: { v: `$registrationData.${ctx.fieldId}` } },
              ],
              as: 'a',
            },
          },
          { $unwind: '$a' },
          { $group: { _id: '$a.v', n: { $sum: 1 } } },
        ]);

      const registered: Record<string, number> = {};
      let registeredTotal = 0;
      for (const { _id, n } of rows) {
        registeredTotal += n;
        const g = ctx.resolve(_id);
        if (g) registered[g.key] = (registered[g.key] ?? 0) + n;
      }
      state.registered = registered;
      state.registeredTotal = registeredTotal;
    } catch (e) {
      this.logger.warn(
        `No se pudieron contar los inscritos ${eventId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * ¿El asistente no debe ver mensajes? Su grupo está excluido, o cayó en el
   * grupo de control mientras el experimento está activo (holdout > 0).
   */
  private isMuted(
    ctx: HerdContext,
    state: HerdState,
    attendeeId: string,
    key: string,
  ) {
    return (
      ctx.excludedKeys.has(key) ||
      (ctx.holdoutPercent > 0 && state.arms.get(attendeeId) === 'c')
    );
  }

  /** Brazos del experimento persistidos (sobreviven a reinicios del proceso) */
  private async loadArms(eventId: string): Promise<Map<string, Arm>> {
    try {
      const snap = await this.rtdb.ref(`/herd/${eventId}/arms`).once('value');
      const val = (snap.val() ?? {}) as Record<string, Arm>;
      return new Map(Object.entries(val));
    } catch (e) {
      this.logger.warn(
        `No se pudo leer el experimento ${eventId}: ${(e as Error).message}`,
      );
      return new Map();
    }
  }

  /** Orden de llegada persistido (sobrevive a reinicios del proceso) */
  private async loadArrivals(
    eventId: string,
  ): Promise<Map<string, Map<string, number>>> {
    const arrivals = new Map<string, Map<string, number>>();
    try {
      const snap = await this.rtdb
        .ref(`/herd/${eventId}/arrivals`)
        .once('value');
      const val = (snap.val() ?? {}) as Record<string, Record<string, number>>;
      for (const [key, byId] of Object.entries(val)) {
        arrivals.set(key, new Map(Object.entries(byId ?? {})));
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo leer el orden de llegada ${eventId}: ${(e as Error).message}`,
      );
    }
    return arrivals;
  }

  private async resolveGroups(
    eventId: string,
    ctx: HerdContext,
    attendeeIds: string[],
    forceRefresh: Set<string>,
  ): Promise<Map<string, Group | null>> {
    const cache: Map<string, CachedGroup> =
      this.attendeeGroups.get(eventId) ?? new Map();
    this.attendeeGroups.set(eventId, cache);

    const now = Date.now();
    const missing = attendeeIds.filter((id) => {
      const c = cache.get(id);
      return !c || forceRefresh.has(id) || now - c.at > this.GROUP_TTL_MS;
    });
    if (missing.length && ctx.fieldId) {
      const path = `registrationData.${ctx.fieldId}`;
      const docs = await this.orgAttendeeModel
        .find({ _id: { $in: missing } }, { [path]: 1 })
        .lean();
      const found = new Map(docs.map((d: any) => [String(d._id), d]));
      for (const id of missing) {
        const raw = found.get(id)?.registrationData?.[ctx.fieldId];
        cache.set(id, { group: ctx.resolve(raw), at: now });
      }
    }
    return new Map(attendeeIds.map((id) => [id, cache.get(id)?.group ?? null]));
  }

  /**
   * Anuncio lanzado a mano desde el admin. Ignora intervalo, hitos y los
   * switches de los mensajes automáticos. `text` reemplaza la plantilla solo
   * esta vez.
   * - public: con el conteo actual del grupo (o del más grande si no se
   *   indica); reinicia el intervalo para que el automático no lo repita.
   * - private: cada asistente conectado (o solo los del grupo) ve otra vez su
   *   mensaje personalizado; lo arma cada navegador con su nombre y grupo.
   */
  async announceNow(
    eventId: string,
    type: 'public' | 'private',
    key?: string,
    text?: string,
  ) {
    if (this.replayEvents.has(eventId)) {
      throw new BadRequestException(
        'El evento está en diferido: los anuncios de manada solo se muestran en vivo',
      );
    }
    const state = this.states.get(eventId);
    const ctx = await this.getContext(eventId);
    const entries = Object.entries(state?.counts ?? {}).filter(
      ([k, n]) => n > 0 && !ctx?.excludedKeys.has(k),
    );
    if (!state || !entries.length) {
      throw new BadRequestException(
        'Aún no hay asistentes conectados con grupo para anunciar',
      );
    }

    const chosen = key
      ? entries.find(([k]) => k === key)
      : entries.sort(([, a], [, b]) => b - a)[0];
    if (!chosen) {
      throw new BadRequestException('Ese grupo no tiene asistentes conectados');
    }

    if (type === 'private') {
      await this.rtdb.ref(`/herd/${eventId}/privateTrigger`).set({
        key: key ?? null,
        ...(text?.trim() ? { text: text.trim() } : {}),
        at: admin.database.ServerValue.TIMESTAMP,
      });
      const reached = key
        ? (state.counts[key] ?? 0)
        : entries.reduce((sum, [, n]) => sum + n, 0);
      return { type, key: key ?? null, count: reached };
    }

    const [groupKey, count] = chosen;
    const now = Date.now();
    state.announced.set(
      groupKey,
      Math.max(state.announced.get(groupKey) ?? 0, count),
    );
    state.lastAnnouncedAt.set(groupKey, now);
    state.lastPublicAt = now;

    const payload = {
      key: groupKey,
      label: state.labels.get(groupKey)?.label ?? groupKey,
      singular: state.labels.get(groupKey)?.singular ?? groupKey,
      count,
      total: state.total,
      registered: Math.max(state.registered[groupKey] ?? 0, count),
      registeredTotal: Math.max(state.registeredTotal, state.total),
      manual: true,
      ...(text?.trim() ? { text: text.trim() } : {}),
      at: admin.database.ServerValue.TIMESTAMP,
    };
    await this.rtdb.ref(`/herd/${eventId}/public`).set(payload);
    return { type, key: groupKey, label: payload.label, count };
  }

  // ── Experimento: ¿los mensajes retienen? ─────────────────────────────────

  /**
   * Compara la visualización de quienes vieron los mensajes (tratamiento)
   * contra el grupo de control sorteado, entre los asistentes con grupo que
   * estuvieron conectados con el evento en vivo (los mensajes solo se pintan
   * en vivo: quien solo vio el diferido o se fue antes de empezar no pudo
   * verlos). Los grupos excluidos se reportan aparte: no son aleatorios,
   * sirven solo como referencia.
   */
  async getExperimentReport(eventId: string) {
    const ctx = await this.getContext(eventId, true);
    if (!ctx) throw new NotFoundException('Event not found');
    const event = await this.eventModel
      .findById(eventId, { endedAt: 1 })
      .lean();
    const arms = await this.loadArms(eventId);
    const attendeeIds = [...arms.keys()];

    // Grupo actual de cada asistente del experimento (para separar excluidos)
    const groupKey = new Map<string, string | null>();
    if (attendeeIds.length && ctx.fieldId) {
      const path = `registrationData.${ctx.fieldId}`;
      const docs = await this.orgAttendeeModel
        .find({ _id: { $in: attendeeIds } }, { [path]: 1 })
        .lean();
      for (const d of docs as any[]) {
        groupKey.set(
          String(d._id),
          ctx.resolve(d.registrationData?.[ctx.fieldId])?.key ?? null,
        );
      }
    }

    // EventUser → asistente, y visualización acumulada por EventUser
    const eventUsers = await this.eventUserModel
      .find({ eventId }, { _id: 1, attendeeId: 1 })
      .lean();
    const attendeeByEu = new Map(
      eventUsers.map((eu) => [String(eu._id), String(eu.attendeeId)]),
    );
    const rows: Array<{
      _id: unknown;
      playback: number;
      presence: number;
      sessions: number;
      lastSeen: Date;
      wasLive: boolean;
    }> = this.viewingSessionModel
      ? await this.viewingSessionModel.aggregate([
          { $match: { eventId } },
          {
            $group: {
              _id: '$eventUserId',
              playback: { $sum: '$playbackTotalSeconds' },
              presence: { $sum: '$totalWatchTimeSeconds' },
              sessions: { $sum: 1 },
              lastSeen: { $max: '$lastHeartbeat' },
              wasLive: { $max: '$wasLiveDuringSession' },
            },
          },
        ])
      : [];
    const viewing = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const aid = attendeeByEu.get(String(r._id));
      if (aid) viewing.set(aid, r);
    }

    const endedAt = event?.endedAt ? new Date(event.endedAt).getTime() : null;
    type Viewer = {
      playbackMin: number;
      presenceMin: number;
      sessions: number;
      untilEnd: boolean;
    };
    const buckets: Record<'treatment' | 'control' | 'excluded', Viewer[]> = {
      treatment: [],
      control: [],
      excluded: [],
    };
    let notLive = 0;
    for (const [aid, arm] of arms) {
      const v = viewing.get(aid);
      if (!v?.wasLive) {
        notLive++;
        continue;
      }
      const key = groupKey.get(aid);
      const bucket =
        key && ctx.excludedKeys.has(key)
          ? 'excluded'
          : arm === 'c'
            ? 'control'
            : 'treatment';
      buckets[bucket].push({
        playbackMin: (v?.playback ?? 0) / 60,
        presenceMin: (v?.presence ?? 0) / 60,
        sessions: v?.sessions ?? 0,
        untilEnd:
          !!endedAt &&
          !!v?.lastSeen &&
          new Date(v.lastSeen).getTime() >= endedAt - UNTIL_END_MARGIN_MS,
      });
    }

    const summarize = (list: Viewer[]) => {
      const n = list.length;
      const pct = (f: (v: Viewer) => boolean) =>
        n ? Math.round((list.filter(f).length / n) * 1000) / 10 : 0;
      const playback = list.map((v) => v.playbackMin);
      return {
        attendees: n,
        avgPlaybackMin: round1(mean(playback)),
        medianPlaybackMin: round1(median(playback)),
        avgPresenceMin: round1(mean(list.map((v) => v.presenceMin))),
        avgSessions: round1(mean(list.map((v) => v.sessions))),
        watched15Pct: pct((v) => v.playbackMin >= 15),
        watched30Pct: pct((v) => v.playbackMin >= 30),
        watched60Pct: pct((v) => v.playbackMin >= 60),
        untilEndPct: endedAt ? pct((v) => v.untilEnd) : null,
      };
    };

    const t = buckets.treatment.map((v) => v.playbackMin);
    const c = buckets.control.map((v) => v.playbackMin);
    const diff = mean(t) - mean(c);
    return {
      holdoutPercent: ctx.holdoutPercent,
      eventEnded: !!endedAt,
      // Sorteados que nunca estuvieron en vivo: fuera de la comparación
      notLive,
      treatment: summarize(buckets.treatment),
      control: summarize(buckets.control),
      excluded: summarize(buckets.excluded),
      // Diferencia de minutos reproducidos (tratamiento − control)
      lift: {
        playbackMin: round1(diff),
        playbackPct:
          mean(c) > 0 ? Math.round((diff / mean(c)) * 1000) / 10 : null,
        // p < 0.05 → la diferencia difícilmente es azar
        pValue: welchPValue(t, c),
      },
    };
  }

  /** Config, grupos excluidos y resolución de grupo (para el informe del saludo) */
  async contextFor(eventId: string) {
    const ctx = await this.getContext(eventId);
    if (!ctx) return null;
    return {
      config: ctx.config,
      fieldId: ctx.fieldId,
      excludedKeys: ctx.excludedKeys,
      resolve: ctx.resolve,
      arms: await this.loadArms(eventId),
    };
  }

  /** Libera el estado en memoria de un evento (al apagar su watcher) */
  clearEvent(eventId: string) {
    this.contexts.delete(eventId);
    this.attendeeGroups.delete(eventId);
    this.states.delete(eventId);
    this.replayEvents.delete(eventId);
  }
}

// ── Estadística del experimento ─────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Función de distribución de la normal estándar (aprox. Abramowitz-Stegun) */
function normalCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Valor p bilateral de la diferencia de medias (prueba de Welch con
 * aproximación normal; válida con decenas de asistentes por brazo).
 * null si no hay datos suficientes.
 */
export function welchPValue(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const variance = (xs: number[]) => {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (!se) return null;
  const z = (mean(a) - mean(b)) / se;
  return Math.round(2 * (1 - normalCdf(Math.abs(z))) * 1000) / 1000;
}
