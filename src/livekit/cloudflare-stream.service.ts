/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Cloudflare Stream Live es un proveedor de solo-lectura en este backend:
 * el Live Input (RTMPS + playback HLS) se crea manualmente en el dashboard
 * de Cloudflare y se pega en PUT /livekit/config, igual que Vimeo. Este
 * servicio solo consulta la API de Cloudflare para exponer info del live
 * input y las grabaciones (VODs) que Cloudflare genera automáticamente
 * al terminar el live, análogo a lo que MuxService hace con los "assets".
 */
@Injectable()
export class CloudflareStreamService {
  private readonly log = new Logger(CloudflareStreamService.name);
  private readonly accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  private readonly apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';

  private get enabled(): boolean {
    return !!this.accountId && !!this.apiToken;
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  private playbackUrlFor(video: any): string | null {
    return video?.playback?.hls || null;
  }

  private mapVideo(video: any) {
    return {
      id: video.uid as string,
      status: video?.status?.state ?? 'unknown',
      duration:
        typeof video.duration === 'number' && video.duration > 0
          ? video.duration
          : null,
      createdAt: video.created ?? null,
      playbackId: video.uid ?? null,
      replayUrl: this.playbackUrlFor(video),
    };
  }

  /**
   * Info del live input (estado de conexión, no del stream terminado).
   */
  async getLiveStreamInfo(liveInputUid: string) {
    if (!this.enabled) return null;
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/accounts/${this.accountId}/stream/live_inputs/${liveInputUid}`,
        { headers: this.headers() },
      );
      const result = data?.result;
      if (!result) return null;
      return {
        id: result.uid,
        status: result.status ?? 'unknown',
        recentAssetIds: [] as string[],
        activeAssetId: null,
      };
    } catch (error: any) {
      this.log.error(
        `Error getting Cloudflare live input info: ${error?.message}`,
      );
      return null;
    }
  }

  /**
   * Lista las grabaciones (VODs) generadas por Cloudflare para este live input.
   */
  async listAssets(liveInputUid: string): Promise<{
    assets: Array<{
      id: string;
      status: string;
      duration: number | null;
      createdAt: string | null;
      playbackId: string | null;
      replayUrl: string | null;
    }>;
    message: string;
  }> {
    if (!this.enabled) {
      return {
        assets: [],
        message: 'Cloudflare Stream no está configurado en el servidor.',
      };
    }
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/accounts/${this.accountId}/stream/live_inputs/${liveInputUid}/videos`,
        { headers: this.headers() },
      );
      const videos: any[] = data?.result || [];

      if (videos.length === 0) {
        return {
          assets: [],
          message: 'No hay grabaciones disponibles para este evento.',
        };
      }

      const assets = videos.map((v) => this.mapVideo(v));

      return {
        assets,
        message: `Se encontraron ${assets.length} grabación(es).`,
      };
    } catch (error: any) {
      this.log.error(
        `Error listing Cloudflare Stream videos: ${error?.message}`,
      );
      return {
        assets: [],
        message: error?.message || 'Error al listar las grabaciones.',
      };
    }
  }

  /**
   * URL de repetición de la grabación más reciente del live input.
   */
  async getReplayUrl(liveInputUid: string): Promise<{
    replayUrl: string | null;
    assetId: string | null;
    status: 'ready' | 'preparing' | 'not_available' | 'error';
    message: string;
  }> {
    const { assets, message } = await this.listAssets(liveInputUid);

    if (assets.length === 0) {
      return { replayUrl: null, assetId: null, status: 'not_available', message };
    }

    const latest = assets[assets.length - 1];

    if (latest.status !== 'ready') {
      return {
        replayUrl: null,
        assetId: latest.id,
        status: latest.status === 'error' ? 'error' : 'preparing',
        message:
          latest.status === 'error'
            ? `La grabación tiene un estado inesperado: ${latest.status}`
            : 'La grabación se está procesando. Intenta de nuevo en unos minutos.',
      };
    }

    if (!latest.replayUrl) {
      return {
        replayUrl: null,
        assetId: latest.id,
        status: 'error',
        message: 'La grabación no tiene URL de reproducción disponible.',
      };
    }

    return {
      replayUrl: latest.replayUrl,
      assetId: latest.id,
      status: 'ready',
      message: 'Repetición lista para reproducir.',
    };
  }

  /**
   * URL de repetición de una grabación específica por su video UID.
   */
  async getReplayUrlByAssetId(videoUid: string): Promise<{
    replayUrl: string | null;
    assetId: string;
    status: 'ready' | 'preparing' | 'not_available' | 'error';
    message: string;
  }> {
    if (!this.enabled) {
      return {
        replayUrl: null,
        assetId: videoUid,
        status: 'error',
        message: 'Cloudflare Stream no está configurado en el servidor.',
      };
    }
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/accounts/${this.accountId}/stream/${videoUid}`,
        { headers: this.headers() },
      );
      const video = data?.result;
      const mapped = video ? this.mapVideo(video) : null;

      if (!mapped) {
        return {
          replayUrl: null,
          assetId: videoUid,
          status: 'error',
          message: 'No se encontró la grabación en Cloudflare Stream.',
        };
      }

      if (mapped.status !== 'ready') {
        return {
          replayUrl: null,
          assetId: videoUid,
          status: mapped.status === 'error' ? 'error' : 'preparing',
          message:
            mapped.status === 'error'
              ? `La grabación tiene un estado inesperado: ${mapped.status}`
              : 'La grabación se está procesando. Intenta de nuevo en unos minutos.',
        };
      }

      if (!mapped.replayUrl) {
        return {
          replayUrl: null,
          assetId: videoUid,
          status: 'error',
          message: 'La grabación no tiene URL de reproducción disponible.',
        };
      }

      return {
        replayUrl: mapped.replayUrl,
        assetId: videoUid,
        status: 'ready',
        message: 'Repetición lista para reproducir.',
      };
    } catch (error: any) {
      this.log.error(
        `Error getting Cloudflare Stream replay by id: ${error?.message}`,
      );
      return {
        replayUrl: null,
        assetId: videoUid,
        status: 'error',
        message: error?.message || 'Error al obtener la repetición.',
      };
    }
  }
}
