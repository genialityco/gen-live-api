import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import {
  VOD_MIRROR_ACTIVE_STATUSES,
  VodMirrorJob,
  VodMirrorJobDocument,
} from './schemas/vod-mirror-job.schema';
import { EventsService } from './events.service';
import { LiveConfigService } from '../livekit/live-config.service';
import { VimeoService } from '../livekit/vimeo.service';
import {
  BUNNY_STATUS,
  BunnyStreamService,
} from '../livekit/bunny-stream.service';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Cada cuánto se revisan los trabajos pendientes. */
const TICK_MS = 30_000;
/** Máximo de trabajos procesados por revisión. */
const JOBS_PER_TICK = 10;
/** Bloqueo de un trabajo mientras una instancia lo procesa. */
const LOCK_MS = 5 * MIN;

/** Espera entre consultas y tiempo máximo de cada fase. */
const PHASES = {
  waiting_source: { every: 2 * MIN, max: 12 * HOUR },
  importing: { every: 30_000, max: 2 * HOUR },
  encoding: { every: MIN, max: 12 * HOUR },
} as const;

type Job = VodMirrorJob & { _id: unknown };

/**
 * Copia a Bunny Stream la grabación de los vivos hechos con Vimeo y deja el
 * video de Bunny como fuente por defecto de la repetición.
 *
 * Es opcional por evento (`event.bunnyReplayConfig.enabled`, apagada por
 * defecto). Se dispara al pasar el evento a Finalizado o Repetición (ver
 * `EventsService.setStatus`), o al activarla con el evento ya en esos
 * estados, cuando el proveedor del estudio es Vimeo. Como
 * Vimeo tarda en archivar la grabación y Bunny en codificarla (de minutos a
 * horas), el avance se guarda en Mongo (`vod_mirror_jobs`) y un ciclo cada
 * 30 s lo retoma; así sobrevive reinicios y varias instancias de la API (cada
 * trabajo se bloquea mientras una instancia lo procesa).
 *
 * La fuente de Vimeo del evento se conserva como respaldo: el reproductor de
 * la repetición pasa a ella si la de Bunny falla.
 */
@Injectable()
export class VodMirrorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VodMirrorService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @InjectModel(VodMirrorJob.name)
    private readonly jobModel: Model<VodMirrorJobDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
    private readonly liveConfigService: LiveConfigService,
    private readonly vimeo: VimeoService,
    private readonly bunny: BunnyStreamService,
  ) {}

  /** ¿Están las credenciales de Vimeo y Bunny? */
  get configured(): boolean {
    return this.vimeo.enabled && this.bunny.enabled;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    if (!this.configured) {
      this.logger.warn(
        'Copia de grabaciones Vimeo→Bunny desactivada: faltan VIMEO_ACCESS_TOKEN, BUNNY_STREAM_API_KEY o BUNNY_STREAM_LIBRARY_ID.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───────────────────────── API pública ─────────────────────────

  /** ¿El evento tiene activada la copia a Bunny? (apagada por defecto) */
  private async isEnabledFor(eventId: string): Promise<boolean> {
    const ev = await this.eventModel
      .findById(eventId, { bunnyReplayConfig: 1 })
      .lean();
    return ev?.bunnyReplayConfig?.enabled === true;
  }

  /**
   * Activa o desactiva la copia a Bunny en la configuración del evento.
   * Al activarla con el evento ya en Finalizado/Repetición, arranca la copia
   * de inmediato. Al desactivarla, detiene las copias en curso (quedan como
   * fallidas y se retoman si se vuelve a activar). Devuelve el evento.
   */
  async setEnabled(eventId: string, enabled: boolean) {
    const ev = await this.eventModel
      .findByIdAndUpdate(
        eventId,
        { $set: { 'bunnyReplayConfig.enabled': enabled } },
        { new: true },
      )
      .lean();
    if (!ev) throw new NotFoundException('Event not found');

    if (enabled && (ev.status === 'ended' || ev.status === 'replay')) {
      await this.enqueue(eventId, ev.slug);
    } else if (!enabled) {
      await this.jobModel.updateMany(
        { eventId, status: { $in: VOD_MIRROR_ACTIVE_STATUSES } },
        {
          $set: {
            status: 'failed',
            detail: 'La copia a Bunny se desactivó.',
            lastError: 'Desactivada en la configuración del evento.',
            lockedUntil: null,
          },
        },
      );
    }
    return ev;
  }

  /**
   * Crea (o reactiva) la copia de la grabación del vivo del evento. No hace
   * nada si el evento no tiene activada la copia o si el estudio no usa
   * Vimeo. Si la copia ya está lista, la vuelve a poner como fuente por
   * defecto (p. ej. al pasar de Finalizado a Repetición). Nunca lanza: lo
   * llama `setStatus` sin esperar.
   */
  async enqueue(eventId: string, eventSlug?: string | null): Promise<void> {
    try {
      if (!eventSlug) return;
      if (!(await this.isEnabledFor(eventId))) return;
      const cfg = await this.liveConfigService.getFresh(eventSlug);
      const sourceUrl = cfg?.playbackHlsUrl?.trim();
      if (cfg?.provider !== 'vimeo' || !sourceUrl) return;

      if (!VimeoService.parseRef(sourceUrl)) {
        this.logger.warn(
          `[vod-mirror] ${eventSlug}: URL de Vimeo no reconocida (${sourceUrl})`,
        );
        return;
      }
      if (!this.configured) {
        this.logger.warn(
          `[vod-mirror] ${eventSlug}: sin credenciales de Vimeo/Bunny, no se copia la grabación.`,
        );
        return;
      }

      const existing = await this.jobModel
        .findOne({ eventId, sourceUrl })
        .lean();

      if (!existing) {
        try {
          await this.jobModel.create({
            eventId,
            eventSlug,
            sourceProvider: 'vimeo',
            sourceUrl,
            status: 'waiting_source',
            detail: 'Esperando la grabación de Vimeo.',
          });
          this.logger.log(
            `[vod-mirror] ${eventSlug}: copia a Bunny programada desde ${sourceUrl}`,
          );
        } catch (err: unknown) {
          // Carrera con otra llamada que ya lo creó (índice único).
          if ((err as { code?: number })?.code !== 11000) throw err;
        }
      } else if (existing.status === 'ready') {
        await this.apply(existing as Job);
        return;
      } else if (existing.status === 'failed') {
        await this.resetJob(existing._id);
      } else {
        await this.jobModel.updateOne(
          { _id: existing._id },
          { $set: { nextRunAt: new Date() } },
        );
      }
      setImmediate(() => void this.tick());
    } catch (err) {
      this.logger.warn(
        `[vod-mirror] No se pudo programar la copia para ${eventSlug}: ${String(err)}`,
      );
    }
  }

  /** Estado de las copias del evento (más reciente primero). */
  async getStatus(eventId: string) {
    const jobs = await this.jobModel
      .find({ eventId })
      .sort({ createdAt: -1 })
      .lean();
    const ev = await this.eventModel
      .findById(eventId, { bunnyReplayConfig: 1, stream: 1, streams: 1 })
      .lean();
    return {
      enabled: ev?.bunnyReplayConfig?.enabled === true,
      configured: this.configured,
      // Fuentes actuales del evento, para que el panel refleje el cambio de
      // fuente por defecto sin recargar.
      stream: ev?.stream ?? null,
      streams: ev?.streams ?? [],
      jobs: jobs.map((j) => ({
        id: String(j._id),
        sourceProvider: j.sourceProvider,
        sourceUrl: j.sourceUrl,
        sourceVideoId: j.sourceVideoId || null,
        status: j.status,
        detail: j.detail || null,
        lastError: j.lastError || null,
        bunnyVideoId: j.bunnyVideoId || null,
        bunnyUrl: j.bunnyUrl || null,
        applied: j.applied,
        readyAt: j.readyAt ?? null,
        updatedAt: (j as { updatedAt?: Date }).updatedAt ?? null,
      })),
    };
  }

  /**
   * Reintenta las copias fallidas del evento y programa la del vivo actual
   * si aún no existe.
   */
  async retry(eventId: string) {
    const ev = await this.eventModel
      .findById(eventId, { slug: 1, status: 1 })
      .lean();
    if (!ev) throw new NotFoundException('Event not found');
    if (!(await this.isEnabledFor(eventId))) {
      throw new BadRequestException(
        'La copia de la grabación a Bunny está desactivada para este evento.',
      );
    }
    const failed = await this.jobModel
      .find({ eventId, status: 'failed' }, { _id: 1 })
      .lean();
    for (const j of failed) await this.resetJob(j._id);
    await this.enqueue(eventId, ev.slug);
    return this.getStatus(eventId);
  }

  // ───────────────────────── Procesamiento ─────────────────────────

  private async resetJob(id: unknown) {
    await this.jobModel.updateOne(
      { _id: id },
      {
        $set: {
          status: 'waiting_source',
          detail: 'Reintentando: esperando la grabación de Vimeo.',
          lastError: '',
          // Título nuevo: el video fallido anterior no debe confundirse con
          // el de este intento.
          bunnyTitle: '',
          bunnyVideoId: '',
          bunnyUrl: '',
          applied: false,
          attempts: 0,
          phaseStartedAt: new Date(),
          nextRunAt: new Date(),
          lockedUntil: null,
        },
      },
    );
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (let i = 0; i < JOBS_PER_TICK; i++) {
        const job = await this.claimNext();
        if (!job) break;
        await this.process(job);
      }
    } catch (err) {
      this.logger.warn(`[vod-mirror] Error en el ciclo: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Toma el siguiente trabajo vencido y lo bloquea para esta instancia. */
  private async claimNext(): Promise<Job | null> {
    const now = new Date();
    return (await this.jobModel
      .findOneAndUpdate(
        {
          status: { $in: VOD_MIRROR_ACTIVE_STATUSES },
          nextRunAt: { $lte: now },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
        },
        {
          $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
          $inc: { attempts: 1 },
        },
        { sort: { nextRunAt: 1 }, new: true },
      )
      .lean()) as Job | null;
  }

  private async process(job: Job) {
    try {
      // Se desactivó con la copia en curso (p. ej. entre instancias).
      if (!(await this.isEnabledFor(job.eventId))) {
        return await this.fail(
          job,
          'Desactivada en la configuración del evento.',
        );
      }
      if (job.status === 'waiting_source') await this.stepWaitingSource(job);
      else if (job.status === 'importing') await this.stepImporting(job);
      else if (job.status === 'encoding') await this.stepEncoding(job);
    } catch (err: unknown) {
      // Error inesperado o transitorio (red, 429, 5xx): reintentar en la
      // misma fase hasta su tiempo máximo.
      const e = err as {
        message?: string;
        response?: { status?: number; data?: { message?: string } };
      };
      const msg = e?.response?.data?.message ?? e?.message ?? 'error';
      const status = e?.response?.status;
      if (status === 401 || status === 403) {
        await this.fail(
          job,
          `Credenciales rechazadas por el proveedor (${status}): ${msg}`,
        );
      } else {
        await this.wait(job, MIN, undefined, `Error temporal: ${msg}`);
      }
    }
  }

  /** Espera la grabación de Vimeo y, cuando está, pide a Bunny que la baje. */
  private async stepWaitingSource(job: Job) {
    const ref = VimeoService.parseRef(job.sourceUrl);
    if (!ref)
      return this.fail(job, `URL de Vimeo no reconocida: ${job.sourceUrl}`);

    const rec = await this.vimeo.getRecording(ref);
    if (rec.state === 'error') return this.fail(job, rec.reason);
    if (rec.state === 'pending') {
      return this.wait(
        job,
        PHASES.waiting_source.every,
        rec.reason,
        undefined,
        {
          sourceVideoId: rec.videoId ?? job.sourceVideoId,
        },
      );
    }

    // Título único por intento, guardado ANTES de pedir la importación: si
    // la respuesta de Bunny se pierde, el siguiente intento encuentra el
    // video por título en vez de importarlo dos veces.
    let title = job.bunnyTitle;
    if (title) {
      const existing = await this.bunny.findByTitle(title);
      if (existing) return this.toEncoding(job, existing.guid, rec.videoId);
    } else {
      title = `${job.eventSlug}-replay-${String(job._id)}-${Date.now()}`;
      await this.jobModel.updateOne(
        { _id: job._id },
        { $set: { bunnyTitle: title, sourceVideoId: rec.videoId } },
      );
    }

    await this.bunny.fetchFromUrl(rec.downloadUrl, title);
    this.logger.log(
      `[vod-mirror] ${job.eventSlug}: Bunny importando el video ${rec.videoId} de Vimeo`,
    );
    await this.save(job, {
      status: 'importing',
      sourceVideoId: rec.videoId,
      bunnyTitle: title,
      detail: 'Bunny está descargando la grabación de Vimeo.',
      lastError: '',
      phaseStartedAt: new Date(),
      nextRunAt: new Date(Date.now() + PHASES.importing.every),
    });
  }

  /** Espera a que Bunny cree el video importado para conocer su ID. */
  private async stepImporting(job: Job) {
    const video = await this.bunny.findByTitle(job.bunnyTitle);
    if (video) return this.toEncoding(job, video.guid);
    return this.wait(
      job,
      PHASES.importing.every,
      'Bunny está descargando la grabación de Vimeo.',
    );
  }

  private async toEncoding(job: Job, guid: string, sourceVideoId?: string) {
    await this.save(job, {
      status: 'encoding',
      bunnyVideoId: guid,
      ...(sourceVideoId ? { sourceVideoId } : {}),
      detail: 'Bunny está codificando la grabación.',
      lastError: '',
      phaseStartedAt: new Date(),
      nextRunAt: new Date(Date.now() + PHASES.encoding.every),
    });
  }

  /** Espera la codificación en Bunny y deja su URL HLS como fuente. */
  private async stepEncoding(job: Job) {
    const video = await this.bunny.getVideo(job.bunnyVideoId);
    if (
      video.status === BUNNY_STATUS.ERROR ||
      video.status === BUNNY_STATUS.UPLOAD_FAILED
    ) {
      return this.fail(
        job,
        `Bunny no pudo procesar el video ${job.bunnyVideoId} (status=${video.status}).`,
      );
    }
    if (video.status !== BUNNY_STATUS.FINISHED) {
      return this.wait(
        job,
        PHASES.encoding.every,
        `Bunny está codificando la grabación (${video.encodeProgress}%).`,
      );
    }

    const playback = await this.bunny.getPlayback(job.bunnyVideoId);
    if (playback.tokenAuthEnabled) {
      return this.fail(
        job,
        'La librería de Bunny exige URLs firmadas (token authentication): desactívala en la librería o en su pull zone para usarla como repetición.',
      );
    }
    if (!playback.playlistUrl) {
      return this.wait(
        job,
        PHASES.encoding.every,
        'Bunny aún no entrega la URL de reproducción.',
      );
    }

    await this.save(job, {
      status: 'ready',
      bunnyUrl: playback.playlistUrl,
      detail: 'Grabación lista en Bunny.',
      lastError: '',
      readyAt: new Date(),
    });
    this.logger.log(
      `[vod-mirror] ${job.eventSlug}: grabación lista en Bunny ${playback.playlistUrl}`,
    );
    await this.apply({ ...job, bunnyUrl: playback.playlistUrl });
  }

  /**
   * Pone la copia de Bunny como fuente por defecto del evento (solo si está
   * en Finalizado o Repetición; si no, se aplica al volver a esos estados).
   */
  private async apply(job: Job) {
    if (!job.bunnyUrl) return;
    const ours = await this.jobModel
      .find({ eventId: job.eventId, bunnyUrl: { $ne: '' } }, { bunnyUrl: 1 })
      .lean();
    const applied = await this.eventsService.setDefaultReplaySource(
      job.eventId,
      'bunny',
      job.bunnyUrl,
      ours.map((j) => j.bunnyUrl),
    );
    await this.jobModel.updateOne({ _id: job._id }, { $set: { applied } });
  }

  // ───────────────────────── Persistencia ─────────────────────────

  private async save(job: Job, set: Partial<VodMirrorJob>) {
    await this.jobModel.updateOne(
      { _id: job._id },
      { $set: { ...set, lockedUntil: null } },
    );
  }

  /**
   * Reprograma el trabajo en la misma fase, o lo da por fallido si la fase
   * ya superó su tiempo máximo.
   */
  private async wait(
    job: Job,
    delayMs: number,
    detail?: string,
    lastError?: string,
    extra: Partial<VodMirrorJob> = {},
  ) {
    const phase = PHASES[job.status as keyof typeof PHASES];
    const startedAt = new Date(job.phaseStartedAt ?? Date.now()).getTime();
    if (phase && Date.now() - startedAt > phase.max) {
      return this.fail(
        job,
        `Tiempo máximo agotado en la fase ${job.status}: ${lastError ?? detail ?? ''}`.trim(),
      );
    }
    await this.save(job, {
      ...extra,
      ...(detail !== undefined ? { detail } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      nextRunAt: new Date(Date.now() + delayMs),
    });
  }

  private async fail(job: Job, reason: string) {
    this.logger.warn(`[vod-mirror] ${job.eventSlug}: ${reason}`);
    await this.save(job, {
      status: 'failed',
      lastError: reason,
      detail: 'La copia a Bunny falló.',
    });
  }
}
