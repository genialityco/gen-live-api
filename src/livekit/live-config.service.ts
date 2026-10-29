import {
  Injectable,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LiveStreamConfig,
  LiveStreamConfigDocument,
} from './schemas/live-stream-config.schema';
import { EventsService } from '../events/events.service';

export type StreamProviderId = LiveStreamConfig['provider'];

@Injectable()
export class LiveConfigService {
  private readonly log = new Logger(LiveConfigService.name);

  /**
   * Caché en memoria para LiveStreamConfig por eventSlug.
   * Reduce las queries a MongoDB cuando N usuarios solicitan la URL de playback
   * de forma simultánea (p.ej. al inicio del evento con 1500 asistentes).
   * `null` = el evento no tiene config (también se cachea).
   */
  private readonly configCache = new Map<
    string,
    { cfg: LiveStreamConfig | null; expiresAt: number }
  >();
  private readonly CONFIG_CACHE_TTL_MS = 30_000; // 30 segundos

  constructor(
    @InjectModel(LiveStreamConfig.name)
    private readonly model: Model<LiveStreamConfigDocument>,
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
  ) {}

  /**
   * Proveedor según una URL de reproducción o de ingesta (null si no se
   * reconoce: p. ej. un pull zone propio de Bunny). Gcore quedó como legado:
   * no se ofrece en el estudio, pero se sigue reconociendo en configs viejas.
   */
  static providerFromUrl(url?: string | null): StreamProviderId | null {
    if (!url) return null;
    if (/mux\.com/i.test(url)) return 'mux';
    if (/vimeo\.com/i.test(url)) return 'vimeo';
    if (
      /cloudflarestream\.com|videodelivery\.net|live\.cloudflare\.com/i.test(
        url,
      )
    )
      return 'cloudflare';
    if (/mediadelivery\.net|b-cdn\.net/i.test(url)) return 'bunny';
    if (/gvideo\.(co|io)/i.test(url)) return 'gcore';
    return null;
  }

  /**
   * Devuelve la config del estudio, creándola vacía si no existe. Ya NO
   * aprovisiona Mux por su cuenta: crear la transmisión en Mux es explícito
   * (POST /livekit/provision, botón del estudio). Solo la usa el panel del
   * estudio (ruta protegida para el dueñ@ del evento).
   */
  async getOrCreate(eventSlug: string) {
    let cfg = await this.model.findOne({ eventSlug });
    if (!cfg) {
      cfg = await this.model.create({
        eventSlug,
        ingestProtocol: 'rtmp',
        layout: 'speaker',
        maxParticipants: 20,
        status: 'idle',
        provider: 'vimeo',
      });
      this.configCache.delete(eventSlug);
      return cfg;
    }

    // Normaliza provider según las URLs guardadas (credenciales de un
    // proveedor distinto al seleccionado).
    const detected =
      LiveConfigService.providerFromUrl(cfg.playbackHlsUrl) ??
      LiveConfigService.providerFromUrl(cfg.rtmpServerUrl);
    if (detected && detected !== cfg.provider) {
      await this.model.updateOne(
        { eventSlug },
        { $set: { provider: detected } },
      );
      cfg.provider = detected;
      this.configCache.delete(eventSlug);
    }
    return cfg;
  }

  async update(eventSlug: string, patch: Partial<LiveStreamConfig>) {
    // Invalidar caché al modificar para que el próximo get() lea el valor actualizado
    this.configCache.delete(eventSlug);
    const updated = await this.model.findOneAndUpdate(
      { eventSlug },
      { $set: { ...patch, eventSlug } },
      { new: true, upsert: true },
    );
    // Refresca el cache de modo emergencia (RTDB) para que playbackHlsUrl quede
    // al día incluso cuando el cambio viene de /provision (sin setConfig
    // posterior que sincronice event.stream).
    void this.eventsService
      .mirrorEmergencyCacheBySlug(eventSlug)
      .catch((err: unknown) =>
        this.log.warn(
          `No se pudo refrescar el cache de modo emergencia para ${eventSlug}: ${String(err)}`,
        ),
      );
    return updated;
  }

  /**
   * Lectura para asistentes y speakers (sondeo cada pocos segundos): pasa por
   * el caché, no crea nada y cachea también la ausencia de config, así no se
   * consulta Mongo en cada sondeo de cada asistente.
   */
  async getCached(eventSlug: string): Promise<LiveStreamConfig | null> {
    const cached = this.configCache.get(eventSlug);
    if (cached && Date.now() < cached.expiresAt) return cached.cfg;

    const cfg = await this.model.findOne({ eventSlug }).lean();
    this.configCache.set(eventSlug, {
      cfg,
      expiresAt: Date.now() + this.CONFIG_CACHE_TTL_MS,
    });
    return cfg;
  }

  /** Lectura directa de Mongo (sin caché ni creación) que refresca el caché. */
  async getFresh(eventSlug: string): Promise<LiveStreamConfig | null> {
    this.configCache.delete(eventSlug);
    return this.getCached(eventSlug);
  }

  async get(eventSlug: string) {
    const cfg = await this.getCached(eventSlug);
    if (!cfg) throw new NotFoundException('Live config no existe');
    return cfg;
  }

  async deleteByEventSlug(eventSlug: string): Promise<void> {
    this.configCache.delete(eventSlug);
    await this.model.deleteOne({ eventSlug });
  }
}
