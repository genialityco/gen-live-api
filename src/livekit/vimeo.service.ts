/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/** Referencia a un video o a un evento en vivo de Vimeo, sacada de una URL. */
export type VimeoRef = { kind: 'video' | 'event'; id: string };

/**
 * Estado de la grabación de un vivo de Vimeo:
 * - ready: ya se puede descargar (`downloadUrl` es un MP4 temporal).
 * - pending: todavía no (sigue en vivo, archivando o transcodificando).
 * - error: no va a estar (no existe, sin permisos, falló el archivado).
 */
export type VimeoRecording =
  | {
      state: 'ready';
      videoId: string;
      downloadUrl: string;
      name: string | null;
      duration: number | null;
    }
  | { state: 'pending'; videoId: string | null; reason: string }
  | { state: 'error'; videoId: string | null; reason: string };

type DownloadCandidate = {
  link: string;
  type: string;
  quality: string;
  height: number;
  size: number;
};

/**
 * Consulta la API de Vimeo para obtener la grabación que queda al terminar
 * un vivo (Vimeo la guarda en el mismo video, o en un video nuevo del evento
 * si la URL es de un evento recurrente). Solo lectura: no crea nada en Vimeo.
 *
 * Requiere VIMEO_ACCESS_TOKEN de la cuenta dueña del video, con los scopes
 * `private` y `video_files` (sin `video_files` la API no devuelve enlaces de
 * descarga).
 */
@Injectable()
export class VimeoService {
  private readonly log = new Logger(VimeoService.name);
  private readonly token = process.env.VIMEO_ACCESS_TOKEN ?? '';
  private readonly baseUrl = 'https://api.vimeo.com';

  get enabled(): boolean {
    return !!this.token;
  }

  private headers() {
    return {
      Authorization: `bearer ${this.token}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4',
    };
  }

  /**
   * Video o evento según la URL de reproducción del estudio:
   * player.vimeo.com/video/ID, vimeo.com/ID, vimeo.com/ID/HASH,
   * vimeo.com/event/ID (y /embed), vimeo.com/manage/videos/ID.
   */
  static parseRef(url?: string | null): VimeoRef | null {
    if (!url || !/vimeo\.com/i.test(url)) return null;
    const event = url.match(/vimeo\.com\/(?:.*\/)?events?\/(\d+)/i);
    if (event) return { kind: 'event', id: event[1] };
    const video =
      url.match(/player\.vimeo\.com\/video\/(\d+)/i) ??
      url.match(/vimeo\.com\/(?:manage\/videos\/|video\/)?(\d+)(?:[/?#]|$)/i);
    if (video) return { kind: 'video', id: video[1] };
    return null;
  }

  /** Grabación más reciente de la referencia (video o evento). */
  async getRecording(ref: VimeoRef): Promise<VimeoRecording> {
    if (!this.enabled) {
      return {
        state: 'error',
        videoId: null,
        reason: 'VIMEO_ACCESS_TOKEN no está configurado en el servidor.',
      };
    }
    let videoId: string | null = null;
    try {
      videoId =
        ref.kind === 'video' ? ref.id : await this.latestEventVideoId(ref.id);
      if (!videoId) {
        return {
          state: 'pending',
          videoId: null,
          reason: 'El evento de Vimeo todavía no tiene videos.',
        };
      }
      return await this.getVideoRecording(videoId);
    } catch (error: any) {
      return this.fromAxiosError(error, videoId);
    }
  }

  /** Video más reciente de un evento en vivo (cada sesión crea uno). */
  private async latestEventVideoId(eventId: string): Promise<string | null> {
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/me/live_events/${eventId}/videos`,
        {
          headers: this.headers(),
          params: {
            sort: 'date',
            direction: 'desc',
            per_page: 1,
            fields: 'uri',
          },
        },
      );
      const uri: string | undefined = data?.data?.[0]?.uri;
      const id = uri?.match(/\/videos\/(\d+)/)?.[1];
      if (id) return id;
    } catch (error: any) {
      if (error?.response?.status !== 404) throw error;
    }
    // Respaldo: el video asociado al evento en este momento.
    const { data } = await axios.get(
      `${this.baseUrl}/me/live_events/${eventId}`,
      { headers: this.headers(), params: { fields: 'streamable_video.uri' } },
    );
    const uri: string | undefined = data?.streamable_video?.uri;
    return uri?.match(/\/videos\/(\d+)/)?.[1] ?? null;
  }

  private async getVideoRecording(videoId: string): Promise<VimeoRecording> {
    const { data: video } = await axios.get(
      `${this.baseUrl}/videos/${videoId}`,
      {
        headers: this.headers(),
        params: {
          fields:
            'uri,name,duration,status,transcode.status,live.status,download,files,play.progressive',
        },
      },
    );

    const liveStatus: string | undefined = video?.live?.status;
    if (liveStatus === 'archive_error') {
      return {
        state: 'error',
        videoId,
        reason: 'Vimeo no pudo archivar la grabación del vivo.',
      };
    }
    if (liveStatus && liveStatus !== 'done') {
      return {
        state: 'pending',
        videoId,
        reason: `El vivo de Vimeo aún no termina de archivarse (live.status=${liveStatus}).`,
      };
    }

    const status: string | undefined = video?.status;
    if (status === 'transcoding_error' || status === 'uploading_error') {
      return {
        state: 'error',
        videoId,
        reason: `El video de Vimeo tiene un error (status=${status}).`,
      };
    }
    if (status && status !== 'available') {
      return {
        state: 'pending',
        videoId,
        reason: `El video de Vimeo aún no está disponible (status=${status}).`,
      };
    }

    const best = this.pickDownload(video);
    if (!best) {
      // Puede tardar en aparecer tras el archivado; si no aparece nunca, lo
      // más probable es que el token no tenga el scope `video_files`.
      return {
        state: 'pending',
        videoId,
        reason:
          'Vimeo aún no ofrece un archivo descargable del video (si persiste, revisa que el token tenga el scope video_files).',
      };
    }

    return {
      state: 'ready',
      videoId,
      downloadUrl: best.link,
      name: (video?.name as string) ?? null,
      duration:
        typeof video?.duration === 'number' && video.duration > 0
          ? video.duration
          : null,
    };
  }

  /**
   * Mejor archivo descargable: MP4 de mayor resolución; si no hay MP4, el
   * original (`source`). Se descartan los manifiestos HLS/DASH.
   */
  private pickDownload(video: any): DownloadCandidate | null {
    const raw: any[] = [
      ...(Array.isArray(video?.download) ? video.download : []),
      ...(Array.isArray(video?.files) ? video.files : []),
      ...(Array.isArray(video?.play?.progressive)
        ? video.play.progressive
        : []),
    ];
    const candidates: DownloadCandidate[] = raw
      .filter((f) => typeof f?.link === 'string' && f.link)
      .map((f) => ({
        link: f.link as string,
        type: String(f.type ?? ''),
        quality: String(f.quality ?? ''),
        height: Number(f.height) || 0,
        size: Number(f.size) || 0,
      }))
      .filter(
        (f) =>
          !['hls', 'dash'].includes(f.quality) &&
          !/\.(m3u8|mpd)(\?|$)/i.test(f.link),
      );

    const byQuality = (a: DownloadCandidate, b: DownloadCandidate) =>
      b.height - a.height || b.size - a.size;
    const mp4 = candidates
      .filter((f) => f.type === 'video/mp4' && f.quality !== 'source')
      .sort(byQuality);
    if (mp4.length) return mp4[0];
    return candidates.sort(byQuality)[0] ?? null;
  }

  private fromAxiosError(error: any, videoId: string | null): VimeoRecording {
    const status: number | undefined = error?.response?.status;
    const apiMsg: string | undefined =
      error?.response?.data?.developer_message ?? error?.response?.data?.error;
    if (status === 401 || status === 403) {
      return {
        state: 'error',
        videoId,
        reason: `El token de Vimeo no tiene acceso a este video (${status}${apiMsg ? `: ${apiMsg}` : ''}).`,
      };
    }
    if (status === 404) {
      return {
        state: 'error',
        videoId,
        reason: 'El video o evento no existe en la cuenta de Vimeo.',
      };
    }
    this.log.warn(
      `Error consultando Vimeo (${videoId ?? 'evento'}): ${status ?? ''} ${apiMsg ?? error?.message}`,
    );
    // 429 / 5xx / red: transitorio, se reintenta.
    return {
      state: 'pending',
      videoId,
      reason: `Error temporal consultando Vimeo: ${apiMsg ?? error?.message ?? status}`,
    };
  }
}
