/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import axios from 'axios';

/**
 * Estados de un video en Bunny Stream (VideoModelStatus de su OpenAPI):
 * 0 Created, 1 Uploaded, 2 Processing, 3 Transcoding, 4 Finished, 5 Error,
 * 6 UploadFailed, 7 JitSegmenting, 8 JitPlaylistsCreated.
 */
export const BUNNY_STATUS = {
  FINISHED: 4,
  ERROR: 5,
  UPLOAD_FAILED: 6,
} as const;

export type BunnyVideo = {
  guid: string;
  title: string;
  status: number;
  encodeProgress: number;
  length: number;
};

/**
 * Cliente mínimo de la API de Bunny Stream para subir (por URL) las
 * grabaciones de los vivos y obtener su URL HLS de reproducción.
 *
 * Variables de entorno:
 * - BUNNY_STREAM_API_KEY: API key de la librería (Stream → librería → API).
 * - BUNNY_STREAM_LIBRARY_ID: ID numérico de la librería.
 * - BUNNY_STREAM_COLLECTION_ID (opcional): colección donde dejar los videos.
 */
@Injectable()
export class BunnyStreamService {
  private readonly apiKey = process.env.BUNNY_STREAM_API_KEY ?? '';
  private readonly libraryId = process.env.BUNNY_STREAM_LIBRARY_ID ?? '';
  private readonly collectionId = process.env.BUNNY_STREAM_COLLECTION_ID ?? '';
  private readonly baseUrl = 'https://video.bunnycdn.com';

  get enabled(): boolean {
    return !!this.apiKey && !!this.libraryId;
  }

  private headers() {
    return { AccessKey: this.apiKey, Accept: 'application/json' };
  }

  private libraryUrl(path: string) {
    return `${this.baseUrl}/library/${this.libraryId}${path}`;
  }

  /**
   * Pide a Bunny que descargue el video desde `url` (asíncrono: Bunny lo
   * baja y lo codifica por su cuenta). La respuesta no trae el ID del video
   * nuevo: se busca después por `title` (ver `findByTitle`), así que el
   * título debe ser único.
   */
  async fetchFromUrl(url: string, title: string): Promise<void> {
    const { data } = await axios.post(
      this.libraryUrl('/videos/fetch'),
      { url, title },
      {
        headers: this.headers(),
        params: this.collectionId
          ? { collectionId: this.collectionId }
          : undefined,
      },
    );
    if (data && data.success === false) {
      throw new Error(
        `Bunny rechazó la importación: ${data.message ?? data.statusCode}`,
      );
    }
  }

  /** Video de la librería con exactamente ese título (el más reciente). */
  async findByTitle(title: string): Promise<BunnyVideo | null> {
    const { data } = await axios.get(this.libraryUrl('/videos'), {
      headers: this.headers(),
      params: { search: title, orderBy: 'date', itemsPerPage: 20, page: 1 },
    });
    const items: any[] = data?.items ?? [];
    const match = items.find((v) => v?.title === title);
    return match ? this.mapVideo(match) : null;
  }

  async getVideo(guid: string): Promise<BunnyVideo> {
    const { data } = await axios.get(this.libraryUrl(`/videos/${guid}`), {
      headers: this.headers(),
    });
    return this.mapVideo(data);
  }

  /**
   * URL HLS (playlist.m3u8) del video y si la librería exige URLs firmadas
   * (token authentication): en ese caso la URL sin firmar no reproduce.
   */
  async getPlayback(
    guid: string,
  ): Promise<{ playlistUrl: string | null; tokenAuthEnabled: boolean }> {
    const { data } = await axios.get(this.libraryUrl(`/videos/${guid}/play`), {
      headers: this.headers(),
    });
    return {
      playlistUrl: (data?.videoPlaylistUrl as string) || null,
      tokenAuthEnabled: !!data?.tokenAuthEnabled,
    };
  }

  private mapVideo(v: any): BunnyVideo {
    return {
      guid: String(v?.guid ?? ''),
      title: String(v?.title ?? ''),
      status: Number(v?.status ?? 0),
      encodeProgress: Number(v?.encodeProgress ?? 0),
      length: Number(v?.length ?? 0),
    };
  }
}
