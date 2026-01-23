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

  /**
   * Obtiene la URL de repetición (Asset) de un live stream finalizado.
   * Mux crea automáticamente un Asset cuando termina el stream.
   */
  async getReplayUrl(liveStreamId: string): Promise<{
    replayUrl: string | null;
    assetId: string | null;
    status: 'ready' | 'preparing' | 'not_available' | 'error';
    message: string;
  }> {
    try {
      // Obtener el live stream
      const liveStream = await this.mux.video.liveStreams.retrieve(liveStreamId);

      // Verificar si hay assets recientes (grabaciones)
      const recentAssetIds = liveStream.recent_asset_ids || [];

      if (recentAssetIds.length === 0) {
        return {
          replayUrl: null,
          assetId: null,
          status: 'not_available',
          message:
            'No hay grabación disponible. La transmisión puede no haber terminado o no se generó asset.',
        };
      }

      // Obtener el asset más reciente
      const assetId = recentAssetIds[recentAssetIds.length - 1];
      const asset = await this.mux.video.assets.retrieve(assetId);

      // Verificar estado del asset
      if (asset.status === 'preparing') {
        return {
          replayUrl: null,
          assetId,
          status: 'preparing',
          message:
            'La grabación se está procesando. Intenta de nuevo en unos minutos.',
        };
      }

      if (asset.status !== 'ready') {
        return {
          replayUrl: null,
          assetId,
          status: 'error',
          message: `El asset tiene un estado inesperado: ${asset.status}`,
        };
      }

      // Obtener el playback_id del asset
      const playbackId = asset.playback_ids?.[0]?.id;

      if (!playbackId) {
        return {
          replayUrl: null,
          assetId,
          status: 'error',
          message: 'El asset no tiene playback_id disponible.',
        };
      }

      // Construir URL de reproducción HLS
      const replayUrl = `https://stream.mux.com/${playbackId}.m3u8`;

      return {
        replayUrl,
        assetId,
        status: 'ready',
        message: 'Repetición lista para reproducir.',
      };
    } catch (error: any) {
      console.error('Error getting replay URL from Mux:', error);
      return {
        replayUrl: null,
        assetId: null,
        status: 'error',
        message: error?.message || 'Error al obtener la repetición de Mux.',
      };
    }
  }

  /**
   * Obtiene información del live stream
   */
  async getLiveStreamInfo(liveStreamId: string) {
    try {
      const liveStream = await this.mux.video.liveStreams.retrieve(liveStreamId);
      return {
        id: liveStream.id,
        status: liveStream.status,
        recentAssetIds: liveStream.recent_asset_ids || [],
        activeAssetId: liveStream.active_asset_id,
      };
    } catch (error: any) {
      console.error('Error getting live stream info:', error);
      return null;
    }
  }

  /**
   * Lista todos los assets (grabaciones) de un live stream con detalles
   */
  async listAssets(liveStreamId: string): Promise<{
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
    try {
      const liveStream = await this.mux.video.liveStreams.retrieve(liveStreamId);
      const recentAssetIds = liveStream.recent_asset_ids || [];

      if (recentAssetIds.length === 0) {
        return {
          assets: [],
          message: 'No hay grabaciones disponibles para este evento.',
        };
      }

      // Obtener detalles de cada asset
      const assetsResults = await Promise.all(
        recentAssetIds.map(async (assetId: string) => {
          try {
            const asset = await this.mux.video.assets.retrieve(assetId);
            const playbackId = asset.playback_ids?.[0]?.id || null;

            return {
              id: asset.id,
              status: asset.status,
              duration: asset.duration || null, // duración en segundos
              createdAt: asset.created_at || null,
              playbackId,
              replayUrl: playbackId
                ? `https://stream.mux.com/${playbackId}.m3u8`
                : null,
            };
          } catch (err: any) {
            // Assets eliminados de Mux retornan 404 - es normal, solo log breve
            if (err?.status === 404) {
              console.log(`Asset ${assetId} ya no existe en Mux (eliminado)`);
            } else {
              console.warn(`Error fetching asset ${assetId}:`, err?.message);
            }
            return null; // Marcar para filtrar
          }
        }),
      );

      // Filtrar assets que ya no existen (null)
      const assets = assetsResults.filter(
        (a): a is NonNullable<typeof a> => a !== null,
      );

      return {
        assets,
        message:
          assets.length > 0
            ? `Se encontraron ${assets.length} grabación(es).`
            : 'No hay grabaciones disponibles (los assets pueden haber expirado).',
      };
    } catch (error: any) {
      console.error('Error listing assets from Mux:', error);
      return {
        assets: [],
        message: error?.message || 'Error al listar las grabaciones.',
      };
    }
  }

  /**
   * Obtiene la URL de replay de un asset específico por su ID
   */
  async getReplayUrlByAssetId(assetId: string): Promise<{
    replayUrl: string | null;
    assetId: string;
    status: 'ready' | 'preparing' | 'not_available' | 'error';
    message: string;
  }> {
    try {
      const asset = await this.mux.video.assets.retrieve(assetId);

      if (asset.status === 'preparing') {
        return {
          replayUrl: null,
          assetId,
          status: 'preparing',
          message:
            'La grabación se está procesando. Intenta de nuevo en unos minutos.',
        };
      }

      if (asset.status !== 'ready') {
        return {
          replayUrl: null,
          assetId,
          status: 'error',
          message: `El asset tiene un estado inesperado: ${asset.status}`,
        };
      }

      const playbackId = asset.playback_ids?.[0]?.id;

      if (!playbackId) {
        return {
          replayUrl: null,
          assetId,
          status: 'error',
          message: 'El asset no tiene playback_id disponible.',
        };
      }

      const replayUrl = `https://stream.mux.com/${playbackId}.m3u8`;

      return {
        replayUrl,
        assetId,
        status: 'ready',
        message: 'Repetición lista para reproducir.',
      };
    } catch (error: any) {
      console.error('Error getting replay URL by asset ID:', error);
      return {
        replayUrl: null,
        assetId,
        status: 'error',
        message: error?.message || 'Error al obtener la repetición.',
      };
    }
  }
}
