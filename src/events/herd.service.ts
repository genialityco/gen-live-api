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
import { RtdbService } from '../rtdb/rtdb.service';
import { UpdateHerdConfigDto } from './dtos/update-herd-config.dto';

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
  },
  publicMessage: {
    enabled: true,
    template: '¡Ya son {cantidad} {grupo} conectados!',
    position: 'bottom-left',
    durationSec: 6,
    minIntervalSec: 20,
    milestoneEvery: 1,
  },
};

type Group = { key: string; label: string };

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
  labels: Map<string, string>;
  total: number;
  // Último conteo anunciado públicamente por grupo (marca de agua): solo se
  // anuncia al superar este valor, así un asistente que recarga la página no
  // vuelve a disparar "ya son N".
  announced: Map<string, number>;
  lastAnnouncedAt: Map<string, number>;
  lastPublicAt: number;
  // uid → clave del grupo publicado en /herd/{eventId}/members (null = sin grupo)
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
  private states = new Map<string, HerdState>();
  // Serializa el procesamiento por evento (flushes solapados del watcher)
  private chains = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(Organization.name) private orgModel: Model<Organization>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    private rtdb: RtdbService,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  async updateConfig(eventId: string, dto: UpdateHerdConfigDto) {
    const event = await this.eventModel.findById(eventId).lean();
    if (!event) throw new NotFoundException('Event not found');

    const herdConfig: EventHerdConfig = {
      enabled: dto.enabled,
      fieldId: dto.fieldId || undefined,
      groupLabels: (dto.groupLabels ?? []).filter((g) => g.label?.trim()),
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
    ).map((o) => ({
      key: herdKey(o.value),
      value: String(o.value),
      optionLabel: String(o.label ?? o.value),
      label: labels.get(String(o.value)) || String(o.label ?? o.value),
    }));

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

  private labelOverrides(config: EventHerdConfig) {
    return new Map(
      (config.groupLabels ?? []).map((g) => [String(g.value), g.label.trim()]),
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
        return {
          key: herdKey(opt.value),
          label: labels.get(opt.value) || opt.label,
        };
      }
      // Campo de texto libre (o valor fuera de las opciones): agrupa por texto normalizado
      return { key: herdKey(v), label: String(v).trim() };
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
      membersWritten: new Map(),
      activeUids: new Set(),
      counts: {},
      labels: new Map(),
      total: 0,
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
    const labels = new Map<string, string>();
    for (const id of attendeeIds) {
      const g = groups.get(id);
      if (!g) continue;
      counts[g.key] = (counts[g.key] ?? 0) + 1;
      labels.set(g.key, g.label);
    }
    const total = attendeeIds.length;

    // Grupo propio de cada asistente, para su mensaje privado: así la página no
    // depende de tener el registrationData (según cómo inició sesión puede no
    // tenerlo). Solo se escribe al llegar o si su grupo cambió.
    const memberUpdates: Record<string, Group | null> = {};
    for (const m of members) {
      const g = groups.get(m.attendeeId) ?? null;
      const key = g?.key ?? null;
      if (
        state.membersWritten.has(m.uid) &&
        state.membersWritten.get(m.uid) === key
      ) {
        continue;
      }
      state.membersWritten.set(m.uid, key);
      memberUpdates[m.uid] = g;
    }
    if (Object.keys(memberUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/members`).update(memberUpdates);
    }

    state.counts = counts;
    state.labels = labels;
    state.total = total;

    const countsJson = JSON.stringify({ counts, total });
    if (countsJson !== state.countsJson) {
      state.countsJson = countsJson;
      await this.rtdb.ref(`/herd/${eventId}/live`).set({
        counts,
        total,
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

    const every = Math.max(1, pub.milestoneEvery ?? 1);
    const pending = Object.entries(counts).filter(([k, n]) => {
      const last = state.announced.get(k) ?? 0;
      return n > last && Math.floor(n / every) > Math.floor(last / every);
    });
    if (!pending.length) return;

    const now = Date.now();
    if (now - state.lastPublicAt < (pub.minIntervalSec ?? 20) * 1000) return;

    // Rota entre grupos: primero el anunciado hace más tiempo; a igualdad, el más grande
    pending.sort(
      ([ka, na], [kb, nb]) =>
        (state.lastAnnouncedAt.get(ka) ?? 0) -
          (state.lastAnnouncedAt.get(kb) ?? 0) || nb - na,
    );
    const [key, count] = pending[0];
    // Anunciar el hito alcanzado (no el conteo exacto) cuando se usan hitos
    const shown = every > 1 ? Math.floor(count / every) * every : count;

    state.announced.set(key, count);
    state.lastAnnouncedAt.set(key, now);
    state.lastPublicAt = now;

    await this.rtdb.ref(`/herd/${eventId}/public`).set({
      key,
      label: labels.get(key) ?? key,
      count: shown,
      total,
      at: admin.database.ServerValue.TIMESTAMP,
    });
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
      label: state.labels.get(groupKey) ?? groupKey,
      count,
      total: state.total,
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
