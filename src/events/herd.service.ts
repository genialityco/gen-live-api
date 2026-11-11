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
import {
  Event,
  EventDocument,
  EventHerdConfig,
  HerdExtraConfig,
} from './schemas/event.schema';
import { Organization } from '../organizations/schemas/organization.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { EventUser } from './schemas/event-user.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { HerdAnnouncement } from './schemas/herd-announcement.schema';
import { RtdbService } from '../rtdb/rtdb.service';
import { UpdateHerdConfigDto } from './dtos/update-herd-config.dto';
import { herdGroupName } from './herd-grammar';
import { resolveLiveEnd, stayedUntilEnd } from './live-window';
import { MessageDeliveryService } from './message-delivery.service';
import { DEFAULT_HOLDOUT_PERCENT } from './experiment-defaults';

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

/** Estilo por defecto de los mensajes de manada: tercio inferior claro */
export const HERD_DEFAULT_STYLE = {
  template: 'lowerThird',
  mode: 'static',
  size: 'sm',
  animation: 'slide',
  font: 'montserrat',
  bgColor: 'rgba(255, 255, 255, 0.96)',
  textColor: '#0f172a',
  accentColor: '#2563eb',
};

export const DEFAULT_HERD_CONFIG: Required<
  Omit<
    EventHerdConfig,
    | 'fieldId'
    | 'groupLabels'
    | 'excludedGroups'
    | 'holdoutPercent'
    | 'labelPattern'
    | 'singularPattern'
    | 'extraHerds'
    | 'formalTitle'
  >
> = {
  enabled: false,
  accentColor: '#3b82f6',
  // Mensajes y saludo por defecto: los del evento isglt2-boehringer (acewebinarco)
  privateMessage: {
    enabled: true,
    template:
      '¡Hola {nombre}! Contigo {está|están} conectados {inscritos} profesionales de {grupo_plural} apostándole a la excelencia médica',
    position: 'top-left',
    durationSec: 8,
    repeatEverySec: 0,
    repeatTemplate: '',
    firstCount: 5,
    firstTemplate:
      '¡Hola {nombre}! Eres la {posicion} persona de {grupo_plural} en conectarse',
    ordinalGender: 'f',
    style: { ...HERD_DEFAULT_STYLE },
  },
  publicMessage: {
    enabled: true,
    template: '¡Se conectó un nuevo profesional de {grupo}!',
    position: 'bottom-left',
    durationSec: 6,
    announceOnGrowth: true,
    minIntervalSec: 20,
    milestoneEvery: 10,
    repeatEverySec: 0,
    repeatTemplate: '',
    label: 'Bienvenido',
    style: { ...HERD_DEFAULT_STYLE },
  },
  greeting: {
    enabled: true,
    position: 'bottom-right',
    durationSec: 6,
    cooldownSec: 60,
    holdoutPercent: 20,
  },
};

/** Tratamiento formal por defecto (no se sabe el género del asistente) */
export const DEFAULT_FORMAL_TITLE = 'Dr(a).';

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
 * Grupo propio publicado en /herd/{eventId}/members/{uid}: el de la primera
 * manada con mensajes arriba (lo que leen los clientes anteriores) y los de
 * las demás manadas en `others`. muted = no ve ningún mensaje (todos sus
 * grupos excluidos o grupo de control del experimento)
 */
type MemberEntry = Group & {
  position?: number;
  title?: string; // tratamiento formal ("Dr(a).") antes de su nombre
  muted?: true;
  greet?: true;
  others?: Array<Group & { position?: number }>;
};

/** Una manada: campo del formulario y su resolución valor → grupo */
type HerdDim = {
  fieldId: string;
  // '' en la principal (claves de siempre); "campo~" en las adicionales, para
  // que dos opciones iguales de campos distintos ("Otro") no compartan grupo
  prefix: string;
  resolve: (raw: unknown) => Group | null;
};

/** Clave del grupo `value` en la manada con prefijo `prefix` */
export const herdGroupKey = (prefix: string, value: unknown) =>
  prefix + herdKey(value);

/**
 * Manadas configuradas: la principal (fieldId, groupLabels… de siempre) y
 * las adicionales, sin campos repetidos. Sin principal no hay manadas.
 */
export function herdDims(
  config: EventHerdConfig,
): Array<HerdExtraConfig & { prefix: string }> {
  if (!config.fieldId) return [];
  const seen = new Set([config.fieldId]);
  const extras = (config.extraHerds ?? []).filter(
    (h) =>
      !!h?.fieldId &&
      /^[\w-]+$/.test(h.fieldId) &&
      !seen.has(h.fieldId) &&
      !!seen.add(h.fieldId),
  );
  return [
    {
      fieldId: config.fieldId,
      groupLabels: config.groupLabels,
      excludedGroups: config.excludedGroups,
      labelPattern: config.labelPattern,
      singularPattern: config.singularPattern,
      prefix: '',
    },
    ...extras.map((h) => ({ ...h, prefix: `${h.fieldId}~` })),
  ];
}

/** Brazo del experimento: t = ve los mensajes, c = grupo de control */
type Arm = 't' | 'c';

/** Contexto por evento: config + resolución valor → grupo, con caché */
type HerdContext = {
  config: EventHerdConfig;
  // Campo de la manada principal (null = sin manadas)
  fieldId: string | null;
  dims: HerdDim[];
  // Grupos de un registrationData, uno por manada en la que tiene valor
  groupsOf: (registrationData: any) => Group[];
  // Claves (con prefijo) de los grupos que no reciben mensajes
  excludedKeys: Set<string>;
  holdoutPercent: number;
  // Tratamiento formal: campo, texto y valores normalizados (valor y
  // etiqueta de cada opción elegida) que lo llevan; null = sin tratamiento
  title: { fieldId: string; text: string; accepted: Set<string> } | null;
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
  // uid → entrada publicada en /herd/{eventId}/members, serializada (null = sin grupo)
  membersWritten: Map<string, string | null>;
  // UIDs presentes en el flush anterior: los que no estaban acaban de llegar
  activeUids: Set<string>;
  // Conectados con algún grupo que recibe mensajes (alcance del privado manual)
  audience: number;
};

type CachedGroup = { groups: Group[]; title?: string; at: number };

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
    @InjectModel(HerdAnnouncement.name)
    private announcementModel?: Model<HerdAnnouncement>,
    private deliveries?: MessageDeliveryService,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  async updateConfig(eventId: string, dto: UpdateHerdConfigDto) {
    const event = await this.eventModel.findById(eventId).lean();
    if (!event) throw new NotFoundException('Event not found');

    const named = (labels?: EventHerdConfig['groupLabels']) =>
      (labels ?? []).filter((g) => g.label?.trim() || g.singular?.trim());
    const herdConfig: EventHerdConfig = {
      enabled: dto.enabled,
      fieldId: dto.fieldId || undefined,
      groupLabels: named(dto.groupLabels),
      excludedGroups: [...new Set(dto.excludedGroups ?? [])],
      labelPattern: dto.labelPattern?.trim() || undefined,
      singularPattern: dto.singularPattern?.trim() || undefined,
      extraHerds: (dto.extraHerds ?? [])
        .filter((h) => h.fieldId !== dto.fieldId)
        .map((h) => ({
          fieldId: h.fieldId,
          groupLabels: named(h.groupLabels),
          excludedGroups: [...new Set(h.excludedGroups ?? [])],
          labelPattern: h.labelPattern?.trim() || undefined,
          singularPattern: h.singularPattern?.trim() || undefined,
        })),
      holdoutPercent: dto.holdoutPercent ?? DEFAULT_HOLDOUT_PERCENT,
      formalTitle:
        dto.formalTitle?.fieldId && dto.formalTitle.values?.length
          ? {
              fieldId: dto.formalTitle.fieldId,
              values: [...new Set(dto.formalTitle.values)],
              text: dto.formalTitle.text?.trim() || DEFAULT_FORMAL_TITLE,
            }
          : undefined,
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
    const fields = await this.getFields(eventId);

    // Opciones de todas las manadas; las de las adicionales llevan su campo
    const groups = herdDims(ctx.config)
      .filter((d) => ctx.dims.some((x) => x.fieldId === d.fieldId))
      .flatMap((d) => {
        const labels = this.labelOverrides(d.groupLabels);
        const field = fields.find((f) => f?.id === d.fieldId);
        return (
          (field?.options ?? []) as Array<{
            value: string;
            label: string;
          }>
        ).map((o) => {
          const forms = herdGroupName(
            labels.get(String(o.value)),
            d,
            String(o.label ?? o.value),
          );
          const key = herdGroupKey(d.prefix, o.value);
          return {
            key,
            ...(d.prefix ? { fieldId: d.fieldId } : {}),
            value: String(o.value),
            optionLabel: String(o.label ?? o.value),
            label: forms.plural,
            singular: forms.singular,
            ...(ctx.excludedKeys.has(key) ? { excluded: true } : {}),
          };
        });
      });

    // Manadas en orden, con el patrón para nombrar valores fuera de las opciones
    const herds = herdDims(ctx.config)
      .filter((d) => ctx.dims.some((x) => x.fieldId === d.fieldId))
      .map((d) => ({
        fieldId: d.fieldId,
        prefix: d.prefix,
        labelPattern: d.labelPattern,
        singularPattern: d.singularPattern,
      }));

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
          herds,
          groups,
          // Claves excluidas, incluidas las que no son opción del formulario
          // ("-", "No Aplica" de registros importados): sin ellas el asistente
          // no sabe que está silenciado hasta que el backend publica su grupo
          excludedKeys: [...ctx.excludedKeys],
          holdoutPercent: ctx.holdoutPercent,
          // Respaldo del tratamiento mientras el backend no publica el miembro
          ...(ctx.title
            ? {
                formalTitle: {
                  fieldId: ctx.title.fieldId,
                  text: ctx.title.text,
                  accepted: [...ctx.title.accepted],
                },
              }
            : {}),
          updatedAt: Date.now(),
        }),
      ),
    );
  }

  /** Formas escritas por el admin para cada opción (plural y/o singular) */
  private labelOverrides(groupLabels: EventHerdConfig['groupLabels']) {
    return new Map(
      (groupLabels ?? []).map((g) => [String(g.value), g] as const),
    );
  }

  /** Campos del formulario de registro de la organización del evento */
  private async getFields(eventId: string): Promise<any[]> {
    const event = await this.eventModel.findById(eventId, { orgId: 1 }).lean();
    if (!event) return [];
    const org = await this.orgModel
      .findById(event.orgId, { 'registrationForm.fields': 1 })
      .lean();
    return (org as any)?.registrationForm?.fields ?? [];
  }

  /** Resolución valor → grupo de una manada sobre las opciones de su campo */
  private buildDim(
    d: HerdExtraConfig & { prefix: string },
    field: any,
  ): HerdDim {
    const labels = this.labelOverrides(d.groupLabels);

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
        const forms = herdGroupName(labels.get(opt.value), d, opt.label);
        return {
          key: herdGroupKey(d.prefix, opt.value),
          label: forms.plural,
          singular: forms.singular,
        };
      }
      // Campo de texto libre (o valor fuera de las opciones): agrupa por texto normalizado
      const text = String(v).trim();
      const forms = herdGroupName(undefined, d, text);
      return {
        key: herdGroupKey(d.prefix, v),
        label: forms.plural,
        singular: forms.singular,
      };
    };
    return { fieldId: String(field.id), prefix: d.prefix, resolve };
  }

  /**
   * Tratamiento formal: valores aceptados (valor y etiqueta normalizados de
   * cada opción elegida, igual que buildDim) si el campo sigue en el formulario
   */
  private buildTitle(
    config: EventHerdConfig,
    fields: any[],
  ): HerdContext['title'] {
    const t = config.formalTitle;
    if (!t?.fieldId || !/^[\w-]+$/.test(t.fieldId) || !t.values?.length) {
      return null;
    }
    const field = fields.find((f) => f?.id === t.fieldId);
    if (!field) return null;
    const options = (field.options ?? []) as Array<{
      value: string;
      label: string;
    }>;
    const accepted = new Set<string>();
    for (const v of t.values) {
      accepted.add(norm(v));
      const opt = options.find((o) => String(o.value) === v);
      if (opt?.label) accepted.add(norm(opt.label));
    }
    return {
      fieldId: t.fieldId,
      text: t.text?.trim() || DEFAULT_FORMAL_TITLE,
      accepted,
    };
  }

  /** Tratamiento del asistente según su registrationData ('' = ninguno) */
  private titleOf(ctx: HerdContext, data: any): string {
    if (!ctx.title) return '';
    const raw = data?.[ctx.title.fieldId];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v == null || typeof v === 'object') return '';
    return ctx.title.accepted.has(norm(v)) ? ctx.title.text : '';
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
    const configured = herdDims(config);
    const fields = configured.length ? await this.getFields(eventId) : [];
    const title = this.buildTitle(config, fields);

    // Manadas cuyo campo sigue en el formulario; sin la principal, ninguna
    const dims: HerdDim[] = [];
    const excludedKeys = new Set<string>();
    for (const d of configured) {
      const field = fields.find((f) => f?.id === d.fieldId);
      if (!field) {
        if (!d.prefix) break;
        continue;
      }
      dims.push(this.buildDim(d, field));
      for (const v of d.excludedGroups ?? []) {
        excludedKeys.add(herdGroupKey(d.prefix, v));
      }
    }

    const groupsOf = (data: any): Group[] =>
      dims
        .map((d) => d.resolve(data?.[d.fieldId]))
        .filter((g): g is Group => !!g);

    const prevFields = cached?.dims.map((d) => d.fieldId).join('|') ?? '';
    const ctx: HerdContext = {
      config,
      fieldId: dims[0]?.fieldId ?? null,
      dims,
      groupsOf,
      excludedKeys,
      holdoutPercent: Math.min(90, Math.max(0, config.holdoutPercent ?? 0)),
      title,
      loadedAt: Date.now(),
    };
    if (prevFields !== dims.map((d) => d.fieldId).join('|')) {
      this.attendeeGroups.delete(eventId);
    }
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
    if (!ctx?.config.enabled || !ctx.dims.length) return;

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
      audience: 0,
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

    // Cada asistente suma en el grupo de cada manada en la que tiene valor
    const counts: Record<string, number> = {};
    const labels = new Map<string, Group>();
    for (const id of attendeeIds) {
      for (const g of groups.get(id) ?? []) {
        counts[g.key] = (counts[g.key] ?? 0) + 1;
        labels.set(g.key, g);
      }
    }
    const total = attendeeIds.length;

    // Orden de llegada dentro de cada grupo: se asigna la primera vez que se
    // ve al asistente en ese grupo y no cambia aunque salga y vuelva.
    const arrivalUpdates: Record<string, number> = {};
    for (const id of attendeeIds) {
      for (const g of groups.get(id) ?? []) {
        const order = state.arrivals.get(g.key) ?? new Map<string, number>();
        state.arrivals.set(g.key, order);
        if (order.has(id)) continue;
        order.set(id, order.size + 1);
        arrivalUpdates[`${g.key}/${id}`] = order.size;
      }
    }
    if (Object.keys(arrivalUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/arrivals`).update(arrivalUpdates);
    }

    // Sorteo del experimento: cada asistente con grupo cae una sola vez en
    // control (no ve mensajes) o tratamiento, con la probabilidad configurada
    const armUpdates: Record<string, Arm> = {};
    for (const id of attendeeIds) {
      if (!groups.get(id)?.length || state.arms.has(id)) continue;
      const arm: Arm = Math.random() * 100 < ctx.holdoutPercent ? 'c' : 't';
      state.arms.set(id, arm);
      armUpdates[id] = arm;
    }
    if (Object.keys(armUpdates).length) {
      await this.rtdb.ref(`/herd/${eventId}/arms`).update(armUpdates);
    }

    // Grupos propios de cada asistente (y su orden de llegada en cada uno),
    // para sus mensajes privados: así la página no depende de tener el
    // registrationData (según cómo inició sesión puede no tenerlo). Solo se
    // escribe al llegar o si sus grupos cambiaron.
    const memberUpdates: Record<string, MemberEntry | null> = {};
    let audience = 0;
    const seen = new Set<string>();
    for (const m of members) {
      const all = groups.get(m.attendeeId) ?? [];
      // Los grupos excluidos no le dan mensajes; si todos lo están, silenciado
      const shown = all.filter((g) => !ctx.excludedKeys.has(g.key));
      const muted =
        all.length > 0 && this.isMuted(ctx, state, m.attendeeId, all);
      if (all.length && !muted && !seen.has(m.attendeeId)) audience++;
      seen.add(m.attendeeId);
      const withPosition = (g: Group) => {
        const position = state.arrivals.get(g.key)?.get(m.attendeeId);
        return { ...g, ...(position ? { position } : {}) };
      };
      // Botón «👋 Saludar» en sus anuncios individuales (saludo activo y en
      // el brazo con botón del experimento del saludo)
      const greet =
        all.length > 0 &&
        !muted &&
        !!ctx.config.greeting?.enabled &&
        greetingHasButton(
          eventId,
          m.attendeeId,
          ctx.config.greeting?.holdoutPercent ?? 0,
        );
      const main = shown[0] ?? all[0];
      const title = this.attendeeGroups.get(eventId)?.get(m.attendeeId)?.title;
      const entry: MemberEntry | null = main
        ? {
            ...withPosition(main),
            ...(title ? { title } : {}),
            ...(muted ? { muted: true as const } : {}),
            ...(greet ? { greet: true as const } : {}),
            ...(!muted && shown.length > 1
              ? { others: shown.slice(1).map(withPosition) }
              : {}),
          }
        : null;
      const written = entry ? JSON.stringify(entry) : null;
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
    state.audience = audience;

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
    this.logPublic(eventId, {
      trigger: repeat ? 'repeat' : 'growth',
      groupKey: key,
      groupLabel: labels.get(key)?.label ?? key,
      count: shown,
      groupConnected: count,
      total,
      audience: state.audience,
      registered: Math.max(registered[key] ?? 0, count),
      registeredTotal: Math.max(registeredTotal, total),
    });
  }

  /**
   * Guarda el anuncio público en el historial (herd_announcements). No
   * bloquea ni rompe el anuncio si Mongo falla: el banner ya salió por RTDB.
   */
  private logPublic(
    eventId: string,
    entry: Omit<HerdAnnouncement, 'eventId' | 'createdAt'>,
  ) {
    if (!this.announcementModel) return;
    void this.announcementModel
      .create({ eventId, ...entry })
      .catch((err) =>
        this.logger.warn(
          `No se pudo guardar el anuncio público de ${eventId}: ${err?.message ?? err}`,
        ),
      );
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
    // El id de cada campo se usa como ruta en la agregación
    const fieldIds = ctx.dims
      .map((d) => d.fieldId)
      .filter((id) => /^[\w-]+$/.test(id));
    if (!fieldIds.length) return;
    // Se agrupa por la combinación de valores de todas las manadas
    const projection = Object.fromEntries(
      fieldIds.map((id) => [id, `$registrationData.${id}`]),
    );
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
                { $project: { v: projection } },
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
        for (const g of ctx.groupsOf(_id)) {
          registered[g.key] = (registered[g.key] ?? 0) + n;
        }
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
   * ¿El asistente no debe ver mensajes? Todos sus grupos están excluidos, o
   * cayó en el grupo de control mientras el experimento está activo (holdout > 0).
   */
  private isMuted(
    ctx: HerdContext,
    state: HerdState,
    attendeeId: string,
    groups: Group[],
  ) {
    return (
      groups.every((g) => ctx.excludedKeys.has(g.key)) ||
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
  ): Promise<Map<string, Group[]>> {
    const cache: Map<string, CachedGroup> =
      this.attendeeGroups.get(eventId) ?? new Map();
    this.attendeeGroups.set(eventId, cache);

    const now = Date.now();
    const missing = attendeeIds.filter((id) => {
      const c = cache.get(id);
      return !c || forceRefresh.has(id) || now - c.at > this.GROUP_TTL_MS;
    });
    if (missing.length) {
      const found = await this.readAttendees(ctx, missing);
      for (const id of missing) {
        const f = found.get(id);
        cache.set(id, {
          groups: f?.groups ?? [],
          ...(f?.title ? { title: f.title } : {}),
          at: now,
        });
      }
    }
    return new Map(attendeeIds.map((id) => [id, cache.get(id)?.groups ?? []]));
  }

  /** Grupos actuales de cada asistente (uno por manada en la que tiene valor) */
  private async readGroups(
    ctx: HerdContext,
    attendeeIds: string[],
  ): Promise<Map<string, Group[]>> {
    const found = await this.readAttendees(ctx, attendeeIds);
    return new Map([...found].map(([id, f]) => [id, f.groups]));
  }

  /** Grupos y tratamiento formal de cada asistente según su registro */
  private async readAttendees(
    ctx: HerdContext,
    attendeeIds: string[],
  ): Promise<Map<string, { groups: Group[]; title: string }>> {
    const result = new Map<string, { groups: Group[]; title: string }>();
    if (!attendeeIds.length || !ctx.dims.length) return result;
    const fieldIds = new Set(ctx.dims.map((d) => d.fieldId));
    if (ctx.title) fieldIds.add(ctx.title.fieldId);
    const projection = Object.fromEntries(
      [...fieldIds].map((f) => [`registrationData.${f}`, 1]),
    );
    const docs = await this.orgAttendeeModel
      .find({ _id: { $in: attendeeIds } }, projection)
      .lean();
    for (const d of docs as any[]) {
      result.set(String(d._id), {
        groups: ctx.groupsOf(d.registrationData),
        title: this.titleOf(ctx, d.registrationData),
      });
    }
    return result;
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
      // Sin grupo: cada conectado con mensajes una vez, aunque esté en varias manadas
      const reached = key ? (state.counts[key] ?? 0) : state.audience;
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
    this.logPublic(eventId, {
      trigger: 'manual',
      groupKey,
      groupLabel: payload.label,
      count,
      groupConnected: count,
      total: state.total,
      audience: state.audience,
      registered: payload.registered,
      registeredTotal: payload.registeredTotal,
      ...(payload.text ? { text: payload.text } : {}),
    });
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
      .findById(eventId, { status: 1, endedAt: 1, liveEndedAt: 1 })
      .lean();
    const arms = await this.loadArms(eventId);
    const attendeeIds = [...arms.keys()];

    // Grupos actuales de cada asistente del experimento (para separar excluidos)
    const groupsById = await this.readGroups(ctx, attendeeIds);

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

    // Cierre real del vivo (no la hora en que se marcó como terminado)
    const liveEnd = resolveLiveEnd(
      event ?? {},
      rows
        .filter((r) => r.wasLive && r.lastSeen)
        .map((r) => new Date(r.lastSeen).getTime()),
    );
    const endedAt = liveEnd.at;
    // Mensajes que efectivamente se le mostraron a cada asistente
    const shownAt = this.deliveries
      ? await this.deliveries.firstShownByAttendee(eventId)
      : new Map<string, number>();
    type Viewer = {
      playbackMin: number;
      presenceMin: number;
      sessions: number;
      untilEnd: boolean;
      shown: boolean;
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
      // Excluido = tiene grupos y todos están excluidos (no vio mensajes)
      const groups = groupsById.get(aid) ?? [];
      const bucket =
        groups.length && groups.every((g) => ctx.excludedKeys.has(g.key))
          ? 'excluded'
          : arm === 'c'
            ? 'control'
            : 'treatment';
      buckets[bucket].push({
        playbackMin: (v?.playback ?? 0) / 60,
        presenceMin: (v?.presence ?? 0) / 60,
        sessions: v?.sessions ?? 0,
        untilEnd:
          !!v?.lastSeen &&
          stayedUntilEnd(new Date(v.lastSeen).getTime(), endedAt),
        shown: shownAt.has(aid),
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
        // % al que se le mostró algún mensaje (null sin registro de entregas)
        shownPct: shownAt.size ? pct((v) => v.shown) : null,
      };
    };

    const t = buckets.treatment.map((v) => v.playbackMin);
    const c = buckets.control.map((v) => v.playbackMin);
    const diff = mean(t) - mean(c);

    // Historial de anuncios públicos (desde que existe herd_announcements)
    const announcements = this.announcementModel
      ? await this.announcementModel
          .find(
            { eventId },
            {
              _id: 0,
              trigger: 1,
              groupKey: 1,
              groupLabel: 1,
              count: 1,
              groupConnected: 1,
              total: 1,
              audience: 1,
              text: 1,
              createdAt: 1,
            },
          )
          .sort({ createdAt: 1 })
          .lean()
      : [];
    const byTrigger = { growth: 0, repeat: 0, manual: 0 };
    for (const a of announcements) byTrigger[a.trigger]++;

    return {
      holdoutPercent: ctx.holdoutPercent,
      eventEnded: !!endedAt,
      // recorded = cierre registrado · status = marcado como terminado ·
      // estimated = salida masiva de la audiencia (eventos anteriores)
      liveEndedAt: endedAt ? new Date(endedAt).toISOString() : null,
      liveEndSource: liveEnd.source,
      // Sorteados que nunca estuvieron en vivo: fuera de la comparación
      notLive,
      treatment: summarize(buckets.treatment),
      control: summarize(buckets.control),
      excluded: summarize(buckets.excluded),
      publicAnnouncements: {
        total: announcements.length,
        byTrigger,
        items: announcements,
      },
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

  /** Config, grupos excluidos y grupos de cada asistente (para el informe del saludo) */
  async contextFor(eventId: string) {
    const ctx = await this.getContext(eventId);
    if (!ctx) return null;
    return {
      config: ctx.config,
      excludedKeys: ctx.excludedKeys,
      groupsFor: (attendeeIds: string[]) => this.readGroups(ctx, attendeeIds),
      arms: await this.loadArms(eventId),
    };
  }

  /**
   * Tratamiento formal ("Dr(a).") de cada asistente según la config de
   * manada del evento ('' = ninguno). Lo usan los logros para nombrar igual
   * que los anuncios de manada.
   */
  async formalTitles(
    eventId: string,
    attendees: Array<{ _id: unknown; registrationData?: any }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ctx = await this.getContext(eventId).catch(() => null);
    if (!ctx?.title) return out;
    for (const a of attendees) {
      const t = this.titleOf(ctx, a.registrationData);
      if (t) out.set(String(a._id), t);
    }
    return out;
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
