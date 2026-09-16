/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/livekit/livekit-egress.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  EgressClient,
  EncodingOptionsPreset,
  StreamProtocol,
  RoomCompositeOptions,
  StreamOutput,
  AccessToken,
} from 'livekit-server-sdk';
import { LiveConfigService } from './live-config.service';

@Injectable()
export class LivekitEgressService {
  private egressClient: EgressClient;
  private apiKey: string;
  private apiSecret: string;
  private wsUrl: string;

  constructor(private readonly liveConfig: LiveConfigService) {
    const apiKey = process.env.LIVEKIT_API_KEY ?? '';
    const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
    const wsUrl = process.env.LIVEKIT_WS_URL ?? '';
    if (!apiKey || !apiSecret || !wsUrl) throw new Error('Missing LiveKit env');

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.wsUrl = wsUrl;

    const host = wsUrl.replace(/^wss?:\/\//, 'https://');
    // Default requestTimeout del SDK es 10s; StartRoomCompositeEgress puede
    // tardar más en responder (crea el egress worker, se suscribe a la room)
    // y con 3 regiones de failover eso agota los 10s antes de completar.
    this.egressClient = new EgressClient(host, apiKey, apiSecret, {
      requestTimeout: 30,
    });
  }

  roomName(eventSlug: string) {
    return `event_${eventSlug}`;
  }

  private async createEgressToken(roomName: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `egress-bot-${Date.now()}`,
      name: 'Egress Template',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      hidden: true, // No aparece en lista de participantes
    });

    return await at.toJwt();
  }

  private buildOpts(
    layout:
      | 'grid'
      | 'speaker'
      | 'presentation'
      | 'pip'
      | 'pip_center'
      | 'side_by_side'
      | 'solo',
    eventSlug: string,
    token: string,
  ): RoomCompositeOptions {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const params = new URLSearchParams({
      eventSlug,
      layout,
      url: this.wsUrl,
      token,
    });

    return {
      layout,
      encodingOptions: EncodingOptionsPreset.H264_720P_30,
      customBaseUrl: `${frontendUrl}/lk-egress?${params.toString()}`,
    };
  }

  async startEgress(eventSlug: string) {
    console.log(`🔎 [egress] startEgress() called for eventSlug=${eventSlug}`);

    const cfg = await this.liveConfig.getOrCreate(eventSlug);
    const roomName = this.roomName(eventSlug);

    console.log('🔎 [egress] config cargado:', {
      eventSlug,
      provider: cfg.provider,
      ingestProtocol: cfg.ingestProtocol,
      status: cfg.status,
      providerStreamId: cfg.providerStreamId,
      rtmpServerUrl: cfg.rtmpServerUrl,
      rtmpStreamKey: cfg.rtmpStreamKey,
      srtIngestUrl: cfg.srtIngestUrl,
      playbackHlsUrl: cfg.playbackHlsUrl,
    });

    const output = new StreamOutput();

    try {
      if (cfg.ingestProtocol === 'rtmp') {
        const base = (cfg.rtmpServerUrl || '').replace(/\/+$/, '');
        const key = (cfg.rtmpStreamKey || '').trim();

        if (!base || !key) {
          throw new BadRequestException('RTMP no configurado para este evento');
        }

        const rtmpUrl = `${base}/${key}`;

        console.log('🔎 [egress] URL RTMP/RTMPS construida:', {
          eventSlug,
          rtmpServerUrl: base,
          rtmpStreamKey: key,
          rtmpUrlCompleta: rtmpUrl,
          scheme: rtmpUrl.split('://')[0],
        });

        output.protocol = StreamProtocol.RTMP;
        output.urls = [rtmpUrl];
      } else {
        if (!cfg.srtIngestUrl) {
          throw new BadRequestException('SRT no configurado para este evento');
        }
        console.log('🔎 [egress] URL SRT:', {
          eventSlug,
          srtIngestUrl: cfg.srtIngestUrl,
        });
        output.protocol = StreamProtocol.SRT;
        output.urls = [cfg.srtIngestUrl];
      }

      // Generar token para el egress template
      const egressToken = await this.createEgressToken(roomName);
      console.log('🔎 [egress] Token del template generado, len=', egressToken.length);

      const opts = this.buildOpts(cfg.layout, eventSlug, egressToken);

      console.log('▶️ Starting egress with options:', {
        roomName,
        output,
        opts,
      });

      const startedAt = Date.now();
      console.log(
        `🔎 [egress] Llamando egressClient.startRoomCompositeEgress() a las ${new Date(startedAt).toISOString()} (host=${this.wsUrl})`,
      );

      const info = await this.egressClient.startRoomCompositeEgress(
        roomName,
        output,
        opts,
      );

      console.log(
        `✅ Egress started (tardó ${Date.now() - startedAt}ms):`,
        {
          egressId: info.egressId,
          status: info.status,
          roomName: info.roomName,
        },
      );

      await this.liveConfig.update(eventSlug, {
        status: 'starting',
        activeEgressId: info.egressId,
        lastError: '',
      });

      return info;
    } catch (e: any) {
      console.log('❌ Error starting egress:', {
        eventSlug,
        provider: cfg.provider,
        ingestProtocol: cfg.ingestProtocol,
        rtmpServerUrl: cfg.rtmpServerUrl,
        rtmpStreamKey: cfg.rtmpStreamKey,
        error: e?.message,
        name: e?.name,
        code: e?.code,
        status: e?.status,
        stack: e?.stack,
      });
      await this.liveConfig.update(eventSlug, {
        status: 'failed',
        lastError: e?.message || 'Egress start failed',
      });
      throw e;
    }
  }

  async stopEgress(egressId: string) {
    return this.egressClient.stopEgress(egressId);
  }

  async getEgress(egressId: string) {
    try {
      const egressList = await this.egressClient.listEgress();
      type EgressInfo = { egressId: string; [key: string]: any };
      const egressInfo = (egressList as EgressInfo[]).find(
        (egress) => egress.egressId === egressId,
      );
      if (!egressInfo) {
        throw new Error(`Egress with ID ${egressId} not found`);
      }
      return egressInfo;
    } catch (error) {
      throw new Error(
        `Failed to get egress info: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
