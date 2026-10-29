/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/livekit/livekit.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  BadRequestException,
  ForbiddenException,
  Put,
  UseGuards,
  Req,
  Inject,
  UploadedFile,
  UseInterceptors,
  Delete,
  Patch,
  forwardRef,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LivekitService } from './livekit.service';
import { LiveConfigService, StreamProviderId } from './live-config.service';
import { MuxService } from './mux.service';
import { CloudflareStreamService } from './cloudflare-stream.service';
import { EventsService } from '../events/events.service';
import { FirebaseAuthGuard } from 'src/common/guards/firebase-auth.guard';
import { EventSlugOwnerGuard } from 'src/common/guards/event-slug-owner.guard';
import { LiveStreamConfig } from './schemas/live-stream-config.schema';
import * as admin from 'firebase-admin';

export class EnsureRoomDto {
  @IsString()
  eventSlug: string;
}

export class TokenQueryDto {
  @IsString()
  eventSlug: string;

  @IsIn(['host', 'speaker', 'viewer'])
  role: 'host' | 'speaker' | 'viewer';

  @IsOptional()
  @IsString()
  identity?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  subtitle?: string;
}
@Controller('livekit')
export class LivekitController {
  constructor(
    private readonly livekitService: LivekitService,
    private readonly liveConfig: LiveConfigService,
    private readonly muxService: MuxService,
    private readonly cloudflareStreamService: CloudflareStreamService,
    @Inject('RTDB') private readonly rtdb: admin.database.Database,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: typeof admin,
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
  ) {}

  @Post('rooms/ensure')
  async ensureRoom(@Body() body: EnsureRoomDto) {
    if (!body.eventSlug) {
      throw new BadRequestException('eventSlug es requerido');
    }

    const room = await this.livekitService.ensureRoomForEvent(body.eventSlug);
    return {
      roomName: room.name,
      numParticipants: room.numParticipants,
      metadata: room.metadata,
    };
  }

  @Get('token')
  async getToken(@Query() query: TokenQueryDto) {
    const { eventSlug, role, identity, name, subtitle } = query;
    if (!eventSlug || !role) {
      throw new BadRequestException('eventSlug y role son requeridos');
    }

    const token = await this.livekitService.createToken({
      eventSlug,
      role,
      identity,
      name,
      subtitle,
    });
    console.log(token);
    return { token };
  }

  /**
   * POST /livekit/provision
   * Provisiona o re-provisiona un live event con Mux via API.
   * Para Vimeo, Cloudflare y Bunny las credenciales se ingresan
   * manualmente en PUT /livekit/config.
   */
  @Post('provision')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async provision(
    @Body()
    body: {
      eventSlug: string;
      provider: 'mux';
    },
  ) {
    if (!body.eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!body.provider) throw new BadRequestException('provider requerido');

    if (body.provider !== 'mux') {
      throw new BadRequestException(
        'Solo Mux se auto-provisiona. Para Vimeo y Cloudflare Stream, ingresa las credenciales manualmente en la configuración.',
      );
    }

    const m = await this.muxService.createLiveStream();
    const cfg = await this.liveConfig.update(body.eventSlug, {
      provider: 'mux',
      providerStreamId: m.providerStreamId,
      providerPlaybackId: m.providerPlaybackId,
      ingestProtocol: 'rtmp',
      rtmpServerUrl: m.rtmpServerUrl,
      rtmpStreamKey: m.rtmpStreamKey,
      playbackHlsUrl: m.playbackHlsUrl,
      lastError: '',
    });

    // Sync estudio→evento: al auto-provisionar (crear) el live stream de Mux
    // también refleja el playbackHlsUrl en event.stream/event.streams (ver
    // setConfig más abajo, misma lógica para la vía de edición manual).
    if (m.playbackHlsUrl) {
      try {
        await this.eventsService.syncStreamFromStudio(body.eventSlug, {
          url: m.playbackHlsUrl,
          provider: 'mux',
        });
      } catch {
        // No bloquear el aprovisionamiento si el sync al evento falla
      }
    }

    return {
      ok: true,
      provider: cfg!.provider,
      providerStreamId: cfg!.providerStreamId,
      rtmpServerUrl: cfg!.rtmpServerUrl,
      rtmpStreamKey: cfg!.rtmpStreamKey ? '****' : '',
      playbackHlsUrl: cfg!.playbackHlsUrl,
    };
  }

  @Put('config')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async setConfig(
    @Body()
    body: {
      eventSlug: string;
      provider?: 'vimeo' | 'cloudflare' | 'mux' | 'gcore' | 'bunny';
      ingestProtocol?: 'rtmp' | 'srt';
      rtmpServerUrl?: string;
      rtmpStreamKey?: string;
      srtIngestUrl?: string;
      playbackHlsUrl?: string;
      layout?:
        | 'grid'
        | 'speaker'
        | 'presentation'
        | 'pip'
        | 'pip_center'
        | 'side_by_side'
        | 'solo';
      showFrame?: boolean;
      frameUrl?: string;
      joinRequestsEnabled?: boolean;
    },
  ) {
    if (!body.eventSlug) throw new BadRequestException('eventSlug requerido');

    const allowSecrets = process.env.ALLOW_LIVE_CREDENTIAL_EDIT !== 'false';

    const patch: any = { ...body };

    if (!allowSecrets) {
      delete patch.rtmpServerUrl;
      delete patch.rtmpStreamKey;
      delete patch.srtIngestUrl;
      delete patch.playbackHlsUrl;
    }

    // allow frame settings
    if (typeof body.showFrame === 'boolean') patch.showFrame = body.showFrame;
    if (typeof body.frameUrl === 'string') patch.frameUrl = body.frameUrl;

    // El proveedor lo elige el productor en el estudio; si no viene, se
    // deduce de la URL de reproducción (y si tampoco se reconoce, se deja el
    // que ya tenía la config).
    const provider: StreamProviderId | null =
      body.provider ??
      (typeof patch.playbackHlsUrl === 'string'
        ? LiveConfigService.providerFromUrl(patch.playbackHlsUrl)
        : null);
    if (provider) patch.provider = provider;

    // Cloudflare: el UID del live input (para buscar grabaciones) sale de la
    // URL de reproducción; no hay campo para pegarlo aparte.
    if (provider === 'cloudflare' && typeof patch.playbackHlsUrl === 'string') {
      const uid = CloudflareStreamService.liveInputUidFrom({
        playbackHlsUrl: patch.playbackHlsUrl,
      });
      if (uid) patch.providerStreamId = uid;
    }

    const saved = await this.liveConfig.update(body.eventSlug, patch);

    // Sync estudio→evento: reflejar el playbackHlsUrl en event.stream para que el
    // endpoint público y los consumidores queden coherentes. syncStreamFromStudio
    // respeta la fase (solo upcoming/live) para no pisar la URL de replay.
    if (
      allowSecrets &&
      typeof patch.playbackHlsUrl === 'string' &&
      patch.playbackHlsUrl
    ) {
      try {
        await this.eventsService.syncStreamFromStudio(body.eventSlug, {
          url: patch.playbackHlsUrl,
          provider: saved.provider,
        });
      } catch {
        // No bloquear el guardado de config si el sync al evento falla
      }
    }

    return { ok: true, id: saved._id, allowSecrets };
  }

  /**
   * GET /livekit/config — config completa del estudio, con credenciales de
   * ingesta (stream key / SRT) en claro para que el productor las verifique
   * o las copie a OBS. Solo para el dueñ@ del evento.
   */
  @Get('config')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async getConfig(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    const cfg = await this.liveConfig.getOrCreate(eventSlug);

    return {
      eventSlug: cfg.eventSlug,
      provider: cfg.provider,
      providerStreamId: cfg.providerStreamId || '',
      ingestProtocol: cfg.ingestProtocol,
      rtmpServerUrl: cfg.rtmpServerUrl,
      rtmpStreamKey: cfg.rtmpStreamKey || '',
      srtIngestUrl: cfg.srtIngestUrl || '',
      playbackHlsUrl: cfg.playbackHlsUrl,
      maxParticipants: cfg.maxParticipants,
      status: cfg.status,
      activeEgressId: cfg.activeEgressId,
      lastError: cfg.lastError,
      ...this.publicFields(cfg),
    };
  }

  /**
   * GET /livekit/public-config — lo que necesitan asistentes y speakers
   * (marco, capa de medios, botón de unirse), sin credenciales. Sin auth y
   * con caché de 30 s: la página del asistente la sondea cada pocos
   * segundos. `fresh=1` salta el caché (estudio, pocos usuarios). No crea
   * la config si no existe: devuelve los valores por defecto.
   */
  @Get('public-config')
  async getPublicConfig(
    @Query('eventSlug') eventSlug: string,
    @Query('fresh') fresh?: string,
  ) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    const cfg =
      fresh === '1'
        ? await this.liveConfig.getFresh(eventSlug)
        : await this.liveConfig.getCached(eventSlug);
    return { eventSlug, ...this.publicFields(cfg ?? {}) };
  }

  private publicFields(cfg: Partial<LiveStreamConfig>) {
    return {
      layout: cfg.layout ?? 'speaker',
      showFrame: !!cfg.showFrame,
      frameUrl: cfg.frameUrl || '',
      // Configs anteriores al campo no lo tienen: habilitado
      joinRequestsEnabled: cfg.joinRequestsEnabled !== false,
      // Media library support - dual layer
      activeVisualItemId: cfg.activeVisualItemId || '',
      activeAudioItemId: cfg.activeAudioItemId || '',
      activeMediaItemId: cfg.activeMediaItemId || '', // Legacy
      mediaEnabled: !!cfg.mediaEnabled,
      // Legacy fields
      mediaUrl: cfg.mediaUrl || '',
      mediaType: cfg.mediaType || 'image',
      // Override fields
      mediaMode: cfg.mediaMode,
      mediaLoop: cfg.mediaLoop,
      mediaMuted: cfg.mediaMuted,
      mediaFit: cfg.mediaFit,
      mediaOpacity: cfg.mediaOpacity,
      // Background
      backgroundUrl: cfg.backgroundUrl || '',
      backgroundType: cfg.backgroundType || 'image',
      backgroundColor: cfg.backgroundColor || '#000000',
    };
  }

  @Post('join-request')
  @UseGuards(FirebaseAuthGuard) // si ya lo tienes para identificar uid
  async requestJoin(
    @Body() body: { eventSlug: string; name?: string },
    @Req() req: any,
  ) {
    const uid = req.user.uid;
    const eventSlug = body.eventSlug;
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    // El admin puede apagar las solicitudes desde el control del evento
    const cfg = await this.liveConfig.get(eventSlug).catch(() => null);
    if (cfg?.joinRequestsEnabled === false) {
      throw new ForbiddenException(
        'Las solicitudes para unirse al estudio están desactivadas',
      );
    }

    const ref = this.rtdb.ref(`/live/${eventSlug}/joinRequests`).push();
    await ref.set({
      uid,
      name: body.name ?? '',
      status: 'pending',
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });

    return { ok: true, requestId: ref.key };
  }

  @Post('join-approve')
  async approveJoin(@Body() body: { eventSlug: string; requestId: string }) {
    const { eventSlug, requestId } = body;
    if (!eventSlug || !requestId) throw new BadRequestException('Faltan datos');

    const reqRef = this.rtdb.ref(
      `/live/${eventSlug}/joinRequests/${requestId}`,
    );
    const snap = await reqRef.once('value');
    const reqData = snap.val();
    if (!reqData) throw new BadRequestException('Request no existe');

    const uid = reqData.uid as string;

    // token speaker
    const token = await this.livekitService.createToken({
      eventSlug,
      role: 'speaker',
      identity: uid,
      name: reqData.name ?? undefined,
    });

    await reqRef.update({ status: 'approved' });

    await this.rtdb.ref(`/live/${eventSlug}/joinDecisions/${uid}`).set({
      status: 'approved',
      role: 'speaker',
      token,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return { ok: true };
  }

  @Post('join-reject')
  async rejectJoin(
    @Body() body: { eventSlug: string; requestId: string; message?: string },
  ) {
    const { eventSlug, requestId, message } = body;
    const reqRef = this.rtdb.ref(
      `/live/${eventSlug}/joinRequests/${requestId}`,
    );
    const snap = await reqRef.once('value');
    const reqData = snap.val();
    if (!reqData) throw new BadRequestException('Request no existe');

    const uid = reqData.uid as string;

    await reqRef.update({ status: 'rejected' });
    await this.rtdb.ref(`/live/${eventSlug}/joinDecisions/${uid}`).set({
      status: 'rejected',
      message: message ?? 'No aceptada',
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return { ok: true };
  }

  /**
   * PATCH /livekit/participant/rename
   * Cambia el nombre y/o subtítulo de un participante en la sala LiveKit en tiempo real.
   * El subtítulo se guarda en el metadata del participante (JSON).
   * El cambio se propaga a todos los clientes conectados.
   */
  @Patch('participant/rename')
  @UseGuards(FirebaseAuthGuard)
  async renameParticipant(
    @Body()
    body: {
      eventSlug: string;
      identity: string;
      name?: string;
      subtitle?: string;
    },
  ) {
    const { eventSlug, identity, name, subtitle } = body;
    if (!eventSlug || !identity) {
      throw new BadRequestException('eventSlug e identity son requeridos');
    }
    if (!name?.trim() && subtitle === undefined) {
      throw new BadRequestException('Debes enviar al menos name o subtitle');
    }
    await this.livekitService.updateParticipantInfo(eventSlug, identity, {
      name: name?.trim(),
      subtitle,
    });
    return { ok: true };
  }

  @Patch('participant/mute')
  @UseGuards(FirebaseAuthGuard)
  async muteParticipantTrack(
    @Body()
    body: {
      eventSlug: string;
      identity: string;
      trackSid: string;
      muted: boolean;
    },
  ) {
    const { eventSlug, identity, trackSid, muted } = body;
    if (!eventSlug || !identity || !trackSid) {
      throw new BadRequestException(
        'eventSlug, identity y trackSid son requeridos',
      );
    }
    await this.livekitService.muteParticipantTrack(
      eventSlug,
      identity,
      trackSid,
      muted,
    );
    return { ok: true };
  }

  @Post('kick')
  async kick(@Body() body: { eventSlug: string; uid: string }) {
    const { eventSlug, uid } = body;
    await this.livekitService.removeParticipant(eventSlug, uid);

    await this.rtdb.ref(`/live/${eventSlug}/joinDecisions/${uid}`).set({
      status: 'kicked',
      message: 'Has sido expulsado del estudio',
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return { ok: true };
  }

  // POST /livekit/frame/upload
  @Post('frame/upload')
  @UseInterceptors(FileInterceptor('frame'))
  async uploadFrame(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const eventSlug = req.body.eventSlug as string;
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!file) throw new BadRequestException('frame file required');

    // validate mime
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
      throw new BadRequestException('Only PNG/JPEG allowed');
    }
    // validate size ≤ 5MB
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('File too large (max 5MB)');
    }

    const bucket = this.firebaseAdmin.storage().bucket();
    const timestamp = Date.now();
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filePath = `live-frames/${eventSlug}/frame_${timestamp}.${ext}`;
    const fileRef = bucket.file(filePath);

    // upload
    await fileRef.save(file.buffer, {
      metadata: { contentType: file.mimetype },
      public: true,
    });

    // make public and get URL
    await fileRef.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    // save to mongo
    await this.liveConfig.update(eventSlug, {
      frameUrl: publicUrl,
      showFrame: true,
    });

    return { ok: true, frameUrl: publicUrl };
  }

  // DELETE /livekit/frame
  @Delete('frame')
  async deleteFrame(
    @Query('eventSlug') eventSlug?: string,
    @Body() body?: { eventSlug?: string },
  ) {
    const slug = eventSlug || body?.eventSlug;
    if (!slug) throw new BadRequestException('eventSlug requerido');

    // clear reference in mongo (no need to delete file from bucket)
    await this.liveConfig.update(slug, { frameUrl: '', showFrame: false });
    return { ok: true };
  }

  // POST /livekit/background/upload
  @Post('background/upload')
  @UseInterceptors(FileInterceptor('background'))
  async uploadBackground(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const eventSlug = req.body.eventSlug as string;
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!file) throw new BadRequestException('background file required');

    // Validate mime: image, gif, video
    const validMimes = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'video/mp4',
      'video/webm',
    ];
    if (!validMimes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Only PNG/JPEG/GIF/MP4/WEBM allowed for background',
      );
    }

    // Validate size ≤ 20MB
    if (file.size > 20 * 1024 * 1024) {
      throw new BadRequestException('File too large (max 20MB)');
    }

    // Determine type
    let backgroundType: 'image' | 'gif' | 'video' = 'image';
    let ext = 'jpg';
    if (file.mimetype === 'image/gif') {
      backgroundType = 'gif';
      ext = 'gif';
    } else if (file.mimetype === 'video/mp4') {
      backgroundType = 'video';
      ext = 'mp4';
    } else if (file.mimetype === 'video/webm') {
      backgroundType = 'video';
      ext = 'webm';
    } else if (file.mimetype === 'image/png') {
      ext = 'png';
    }

    const bucket = this.firebaseAdmin.storage().bucket();
    const timestamp = Date.now();
    const filePath = `live-backgrounds/${eventSlug}/background_${timestamp}.${ext}`;
    const fileRef = bucket.file(filePath);

    // Upload
    await fileRef.save(file.buffer, {
      metadata: { contentType: file.mimetype },
      public: true,
    });

    // Make public and get URL
    await fileRef.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    // Save to mongo
    await this.liveConfig.update(eventSlug, {
      backgroundUrl: publicUrl,
      backgroundType,
    });

    return { ok: true, backgroundUrl: publicUrl, backgroundType };
  }

  // DELETE /livekit/background
  @Delete('background')
  async deleteBackground(
    @Query('eventSlug') eventSlug?: string,
    @Body() body?: { eventSlug?: string },
  ) {
    const slug = eventSlug || body?.eventSlug;
    if (!slug) throw new BadRequestException('eventSlug requerido');

    // Clear reference in mongo
    await this.liveConfig.update(slug, {
      backgroundUrl: '',
      backgroundType: 'image',
    });
    return { ok: true };
  }

  // POST /livekit/media/upload
  @Post('media/upload')
  @UseInterceptors(FileInterceptor('media'))
  async uploadMedia(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const eventSlug = req.body.eventSlug as string;
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!file) throw new BadRequestException('media file required');

    const allowed = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'video/mp4',
      'video/webm',
    ];

    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Only PNG/JPEG/GIF or MP4/WEBM allowed');
    }

    const isVideo = file.mimetype.startsWith('video/');
    const max = isVideo ? 60 * 1024 * 1024 : 10 * 1024 * 1024; // ajusta
    if (file.size > max) {
      throw new BadRequestException(
        isVideo ? 'Video too large (max 60MB)' : 'Image too large (max 10MB)',
      );
    }

    const bucket = this.firebaseAdmin.storage().bucket();
    const timestamp = Date.now();

    const ext =
      file.mimetype === 'image/png'
        ? 'png'
        : file.mimetype === 'image/jpeg'
          ? 'jpg'
          : file.mimetype === 'image/gif'
            ? 'gif'
            : file.mimetype === 'video/webm'
              ? 'webm'
              : 'mp4';

    const filePath = `live-media/${eventSlug}/media_${timestamp}.${ext}`;
    const fileRef = bucket.file(filePath);

    await fileRef.save(file.buffer, {
      metadata: { contentType: file.mimetype },
      public: true,
    });

    await fileRef.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    const mediaType = file.mimetype.startsWith('video/')
      ? 'video'
      : file.mimetype === 'image/gif'
        ? 'gif'
        : 'image';

    // guarda en mongo y activa
    await this.liveConfig.update(eventSlug, {
      mediaUrl: publicUrl,
      mediaEnabled: true,
      mediaType,
      // defaults útiles
      mediaMode: 'full',
      mediaMuted: false,
      mediaLoop: true,
      mediaFit: 'cover',
      mediaOpacity: 1,
    });

    return { ok: true, mediaUrl: publicUrl, mediaType };
  }

  // DELETE /livekit/media
  @Delete('media')
  async deleteMedia(
    @Query('eventSlug') eventSlug?: string,
    @Body() body?: { eventSlug?: string },
  ) {
    const slug = eventSlug || body?.eventSlug;
    if (!slug) throw new BadRequestException('eventSlug requerido');

    await this.liveConfig.update(slug, {
      mediaEnabled: false,
      mediaUrl: '',
    });

    return { ok: true };
  }

  /**
   * Devuelve el servicio de proveedor de grabaciones/replay (Mux o Cloudflare
   * Stream) según el provider configurado para el evento, o null si el
   * provider actual no soporta consulta de replays (p.ej. Vimeo/Gcore).
   */
  private replayProviderFor(
    provider: string,
  ): MuxService | CloudflareStreamService | null {
    if (provider === 'mux') return this.muxService;
    if (provider === 'cloudflare') return this.cloudflareStreamService;
    return null;
  }

  /** ID del stream en el proveedor (live stream de Mux / live input de Cloudflare). */
  private providerStreamIdFor(cfg: LiveStreamConfig): string | null {
    if (cfg.provider === 'cloudflare')
      return CloudflareStreamService.liveInputUidFrom(cfg);
    return cfg.providerStreamId || null;
  }

  /**
   * GET /livekit/replay?eventSlug=xxx
   * Obtiene la URL de repetición del live stream (Mux o Cloudflare Stream).
   * Ambos generan automáticamente una grabación cuando termina el stream.
   */
  @Get('replay')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async getReplayUrl(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    const cfg = await this.liveConfig.get(eventSlug);
    const provider = this.replayProviderFor(cfg.provider);
    const streamId = this.providerStreamIdFor(cfg);

    if (!streamId || !provider) {
      return {
        ok: false,
        status: 'not_available',
        message:
          'Este evento no tiene un stream de Mux o Cloudflare Stream provisionado.',
      };
    }

    const result = await provider.getReplayUrl(streamId);
    return {
      ok: result.status === 'ready',
      provider: cfg.provider,
      ...result,
    };
  }

  /**
   * GET /livekit/stream-info?eventSlug=xxx
   * Obtiene información del live stream (Mux o Cloudflare Stream).
   */
  @Get('stream-info')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async getStreamInfo(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    const cfg = await this.liveConfig.get(eventSlug);
    const provider = this.replayProviderFor(cfg.provider);
    const streamId = this.providerStreamIdFor(cfg);

    if (!provider || !streamId) {
      return {
        ok: false,
        message:
          'No hay stream de Mux o Cloudflare Stream configurado para este evento.',
      };
    }

    const info = await provider.getLiveStreamInfo(streamId);

    if (!info) {
      return {
        ok: false,
        message: 'No se pudo obtener información del stream.',
      };
    }

    return {
      ok: true,
      ...info,
    };
  }

  /**
   * GET /livekit/assets?eventSlug=xxx
   * Lista todas las grabaciones disponibles para un evento (Mux o Cloudflare Stream).
   */
  @Get('assets')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async listAssets(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    // Sin config todavía (nunca se configuró el estudio): no hay grabaciones.
    const cfg = await this.liveConfig.getCached(eventSlug);
    const provider = cfg ? this.replayProviderFor(cfg.provider) : null;
    const streamId = cfg ? this.providerStreamIdFor(cfg) : null;

    if (!cfg || !streamId || !provider) {
      return {
        ok: false,
        provider: cfg?.provider ?? null,
        assets: [],
        message:
          'Este evento no tiene un stream de Mux o Cloudflare Stream provisionado.',
      };
    }

    const result = await provider.listAssets(streamId);
    return { ok: true, provider: cfg.provider, ...result };
  }

  /**
   * GET /livekit/replay-by-asset?eventSlug=xxx&assetId=yyy
   * Obtiene la URL de repetición de un asset específico
   */
  @Get('replay-by-asset')
  @UseGuards(FirebaseAuthGuard, EventSlugOwnerGuard)
  async getReplayByAsset(
    @Query('eventSlug') eventSlug: string,
    @Query('assetId') assetId: string,
  ) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!assetId) throw new BadRequestException('assetId requerido');

    const cfg = await this.liveConfig.get(eventSlug);
    const provider = this.replayProviderFor(cfg.provider);

    if (!provider) {
      return {
        ok: false,
        status: 'not_available',
        message: 'Este evento no usa Mux ni Cloudflare Stream como proveedor.',
      };
    }

    const result = await provider.getReplayUrlByAssetId(assetId);

    return {
      ok: result.status === 'ready',
      provider: cfg.provider,
      ...result,
    };
  }
}
