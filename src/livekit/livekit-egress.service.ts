// src/livekit/livekit-egress.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  EgressClient,
  EncodingOptionsPreset,
  StreamProtocol,
  RoomCompositeOptions,
  StreamOutput,
} from 'livekit-server-sdk';
import { LiveConfigService } from './live-config.service';

@Injectable()
export class LivekitEgressService {
  private egressClient: EgressClient;

  constructor(private readonly liveConfig: LiveConfigService) {
    const apiKey = process.env.LIVEKIT_API_KEY ?? '';
    const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
    const wsUrl = process.env.LIVEKIT_WS_URL ?? '';
    if (!apiKey || !apiSecret || !wsUrl) throw new Error('Missing LiveKit env');

    const host = wsUrl.replace(/^wss?:\/\//, 'https://');
    this.egressClient = new EgressClient(host, apiKey, apiSecret);
  }

  roomName(eventSlug: string) {
    return `event_${eventSlug}`;
  }

  private buildOpts(layout: 'grid' | 'speaker'): RoomCompositeOptions {
    return {
      layout,
      encodingOptions: EncodingOptionsPreset.H264_720P_30,
    };
  }

  async startEgress(eventSlug: string) {
    const cfg = await this.liveConfig.getOrCreate(eventSlug);
    const roomName = this.roomName(eventSlug);

    const output = new StreamOutput();

    if (cfg.ingestProtocol === 'rtmp') {
      if (!cfg.rtmpServerUrl || !cfg.rtmpStreamKey) {
        throw new BadRequestException('RTMP no configurado para este evento');
      }
      const rtmpUrl =
        cfg.rtmpServerUrl.replace(/\/+$/, '/') + cfg.rtmpStreamKey;

      output.protocol = StreamProtocol.RTMP;
      output.urls = [rtmpUrl];
    } else {
      if (!cfg.srtIngestUrl) {
        throw new BadRequestException('SRT no configurado para este evento');
      }
      output.protocol = StreamProtocol.SRT;
      output.urls = [cfg.srtIngestUrl];
    }

    const opts = this.buildOpts(cfg.layout);

    const info = await this.egressClient.startRoomCompositeEgress(
      roomName,
      output,
      opts,
    );

    await this.liveConfig.update(eventSlug, {
      status: 'starting',
      activeEgressId: info.egressId,
      lastError: '',
    });

    return info;
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
