/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LiveStreamConfig,
  LiveStreamConfigDocument,
} from './schemas/live-stream-config.schema';
import { MuxService } from './mux.service';

@Injectable()
export class LiveConfigService {
  private readonly log = new Logger(LiveConfigService.name);

  constructor(
    @InjectModel(LiveStreamConfig.name)
    private readonly model: Model<LiveStreamConfigDocument>,
    private readonly mux: MuxService,
  ) {}

  private isMuxUrl(
    cfg: Pick<LiveStreamConfig, 'rtmpServerUrl' | 'playbackHlsUrl'>,
  ) {
    return (
      /mux\.com/i.test(cfg.rtmpServerUrl || '') ||
      /stream\.mux\.com/i.test(cfg.playbackHlsUrl || '')
    );
  }

  private isGcoreUrl(
    cfg: Pick<LiveStreamConfig, 'rtmpServerUrl' | 'playbackHlsUrl'>,
  ) {
    return (
      /gvideo\.co/i.test(cfg.rtmpServerUrl || '') ||
      /gvideo\.io/i.test(cfg.playbackHlsUrl || '')
    );
  }

  /**
   * Reprovisiona Mux si el config está vacío o apunta a Gcore.
   * NO reprovisiona solo porque falta playback si ya es Mux (evita crear streams innecesarios).
   */
  async getOrCreate(eventSlug: string) {
    // 1) crea doc si no existe (upsert suave)
    let cfg = await this.model.findOne({ eventSlug });

    if (!cfg) {
      cfg = await this.model.create({
        eventSlug,
        ingestProtocol: 'rtmp',
        layout: 'grid',
        maxParticipants: 20,
        status: 'idle',
        provider: 'mux', // si ya migraste, lo razonable es default mux
      });
    }

    // 2) Normaliza provider si las URLs dicen lo contrario (para coherencia)
    const urlSaysMux = this.isMuxUrl(cfg);
    const urlSaysGcore = this.isGcoreUrl(cfg);

    if (urlSaysMux && cfg.provider !== 'mux') {
      await this.model.updateOne({ eventSlug }, { $set: { provider: 'mux' } });
      cfg.provider = 'mux' as any;
    } else if (urlSaysGcore && cfg.provider !== 'gcore') {
      await this.model.updateOne(
        { eventSlug },
        { $set: { provider: 'gcore' } },
      );
      cfg.provider = 'gcore' as any;
    }

    // 3) Decide reprovision:
    // - si provider es gcore o urls gcore => reprovision mux
    // - si faltan credenciales y NO parece mux => reprovision mux
    // - si ya parece mux, no crees streams nuevos solo porque falta algo: mejor dejar que lo editen o error controlado
    const missingBasics =
      !cfg.rtmpServerUrl || !cfg.rtmpStreamKey || !cfg.playbackHlsUrl;

    const shouldReprovisionMux =
      cfg.provider === 'gcore' ||
      urlSaysGcore ||
      (missingBasics && !urlSaysMux);

    if (!shouldReprovisionMux) return cfg;

    // 4) Reprovision con guardado atómico (minimiza duplicados)
    // Nota: no es un lock perfecto, pero reduce muchísimo duplicados:
    // volvemos a leer antes de crear, por si otro request ya lo hizo.
    const fresh = await this.model.findOne({ eventSlug });
    const freshSaysMux = fresh ? this.isMuxUrl(fresh) : false;
    if (
      fresh &&
      freshSaysMux &&
      fresh.provider === 'mux' &&
      fresh.rtmpStreamKey &&
      fresh.playbackHlsUrl
    ) {
      return fresh;
    }

    this.log.log(`Reprovisioning Mux for eventSlug=${eventSlug}`);

    const m = await this.mux.createLiveStream();

    const updated = await this.model.findOneAndUpdate(
      { eventSlug },
      {
        $set: {
          provider: 'mux',
          providerStreamId: m.providerStreamId,
          providerPlaybackId: m.providerPlaybackId,
          ingestProtocol: 'rtmp',
          rtmpServerUrl: m.rtmpServerUrl,
          rtmpStreamKey: m.rtmpStreamKey,
          playbackHlsUrl: m.playbackHlsUrl,
          lastError: '',
        },
      },
      { new: true },
    );

    return updated ?? cfg;
  }

  async update(eventSlug: string, patch: Partial<LiveStreamConfig>) {
    return this.model.findOneAndUpdate(
      { eventSlug },
      { $set: { ...patch, eventSlug } },
      { new: true, upsert: true },
    );
  }

  async get(eventSlug: string) {
    const cfg = await this.model.findOne({ eventSlug }).lean();
    if (!cfg) throw new NotFoundException('Live config no existe');
    return cfg;
  }
}
