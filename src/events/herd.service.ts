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
  Omit<EventHerdConfig, 'fieldId' | 'groupLabels'>
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
    minIntervalSec: 20,
    milestoneEvery: 1,
    repeatEverySec: 0,
    repeatTemplate: '',
  },
};

// Repetición mínima: los flushes de presencia llegan cada ~15 s (heartbeats)
const MIN_REPEAT_SEC = 30;

// label = plural ("endocrinólogos"); singular = "endocrinólogo"
type Group = { key: string; label: string; singular: string };

/** Grupo propio publicado en /herd/{eventId}/members/{uid} */
type MemberEntry = Group & { position?: number };

/** Contexto por evento: config + resolución valor → grupo, con caché */
type HerdContext = {
  config: EventHerdConfig;
  fieldId: string | null;
  resolve: (raw: unknown) => Group | null;
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
  // Inicio del estado: la repetición periódica cuenta desde aquí si aún no
  // hubo anuncio, para no anunciar de golpe al arrancar
  startedAt: number;
  // grupo → (attendeeId → orden de llegada 1, 2, 3…). Se persiste en
  // /herd/{eventId}/arrivals para que un reinicio no repita "eres la primera"
  arrivals: Map<string, Map<string, number>>;
  // uid → "clave|posición" publicada en /herd/{eventId}/members (null = sin grupo)
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

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(Organization.name) private orgModel: Model<Organization>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    private rtdb: RtdbService,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
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
      accentColor: dto.accentColor || DEFAULT_HERD_CONFIG.accentColor,
      privateMessage: {
        ...DEFAULT_HERD_CONFIG.privateMessage,
        ...(dto.privateMessage ?? {}),
      },
      publicMessage: {
        ...DEFAULT_HERD_CONFIG.publicMessage,
        ...(dto.publicMessage ?? {}),
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
      };
    });

    const { enabled, accentColor, privateMessage, publicMessage } = ctx.config;
    await this.rtdb.ref(`/herd/${eventId}/config`).set(
      JSON.parse(
        JSON.stringify({
          enabled: !!enabled && !!ctx.fieldId,
          fieldId: ctx.fieldId,
          accentColor,
          privateMessage,
          publicMessage,
          groups,
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
   * registran para no afectar las métricas.
   */
  onActiveAttendees(eventId: string, members: HerdMember[]): Promise<void> {
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
      startedAt: Date.now(),
      arrivals: await this.loadArrivals(eventId),
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
      const entry = g ? { ...g, ...(position ? { position } : {}) } : null;
      const written = g ? `${g.key}|${position ?? ''}` : null;
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
    if (isFirst || !pub.enabled) {
      for (const [k, n] of Object.entries(counts)) state.announced.set(k, n);
      return;
    }

    const now = Date.now();
    const every = Math.max(1, pub.milestoneEvery ?? 1);
    const pending = Object.entries(counts).filter(([k, n]) => {
      const last = state.announced.get(k) ?? 0;
      return n > last && Math.floor(n / every) > Math.floor(last / every);
    });
    const canGrow =
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
        ? Object.entries(counts).filter(([, n]) => n > 0)
        : [];
    if (!candidates.length) return;

    // Rota entre grupos: primero el anunciado hace más tiempo; a igualdad, el más grande
    candidates.sort(
      ([ka, na], [kb, nb]) =>
        (state.lastAnnouncedAt.get(ka) ?? 0) -
          (state.lastAnnouncedAt.get(kb) ?? 0) || nb - na,
    );
    const [key, count] = candidates[0];
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
    const state = this.states.get(eventId);
    const entries = Object.entries(state?.counts ?? {}).filter(
      ([, n]) => n > 0,
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

  /** Libera el estado en memoria de un evento (al apagar su watcher) */
  clearEvent(eventId: string) {
    this.contexts.delete(eventId);
    this.attendeeGroups.delete(eventId);
    this.states.delete(eventId);
  }
}
