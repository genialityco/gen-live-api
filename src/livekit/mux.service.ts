/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable } from '@nestjs/common';
import Mux from '@mux/mux-node';

@Injectable()
export class MuxService {
  private mux: any;

  constructor() {
    const tokenId = process.env.MUX_TOKEN_ID ?? '';
    const tokenSecret = process.env.MUX_TOKEN_SECRET ?? '';
    if (!tokenId || !tokenSecret) {
      throw new Error('Missing MUX_TOKEN_ID / MUX_TOKEN_SECRET');
    }

    this.mux = new Mux({ tokenId, tokenSecret });
  }

  async createLiveStream() {
    // Crea live stream con playback público
    // POST https://api.mux.com/video/v1/live-streams :contentReference[oaicite:2]{index=2}
    const live = await this.mux.video.liveStreams.create({
      playback_policy: ['public'],
      new_asset_settings: { playback_policy: ['public'] },
      latency_mode: 'low',
    });

    const playbackId = live.playback_ids?.[0]?.id;
    if (!playbackId) {
      throw new Error('Mux live stream created without playback id');
    }

    // RTMP server URL standard de Mux :contentReference[oaicite:3]{index=3}
    const rtmpServerUrl = 'rtmp://global-live.mux.com:5222/app';
    const rtmpStreamKey = live.stream_key; // secreto :contentReference[oaicite:4]{index=4}

    // HLS Playback URL estándar :contentReference[oaicite:5]{index=5}
    const playbackHlsUrl = `https://stream.mux.com/${playbackId}.m3u8`;

    return {
      provider: 'mux' as const,
      providerStreamId: live.id,
      providerPlaybackId: playbackId,
      rtmpServerUrl,
      rtmpStreamKey,
      playbackHlsUrl,
    };
  }
}
