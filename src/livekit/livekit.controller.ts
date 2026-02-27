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
  Put,
  UseGuards,
  Req,
  Inject,
  UploadedFile,
  UseInterceptors,
  Delete,
  Patch,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LivekitService } from './livekit.service';
import { LiveConfigService } from './live-config.service';
import { MuxService } from './mux.service';
import { FirebaseAuthGuard } from 'src/common/guards/firebase-auth.guard';
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
}
@Controller('livekit')
export class LivekitController {
  constructor(
    private readonly livekitService: LivekitService,
    private readonly liveConfig: LiveConfigService,
    private readonly muxService: MuxService,
    @Inject('RTDB') private readonly rtdb: admin.database.Database,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: typeof admin,
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
    const { eventSlug, role, identity, name } = query;
    if (!eventSlug || !role) {
      throw new BadRequestException('eventSlug y role son requeridos');
    }

    const token = await this.livekitService.createToken({
      eventSlug,
      role,
      identity,
      name,
    });
    console.log(token);
    return { token };
  }

  /**
   * POST /livekit/provision
   * Provisiona o re-provisiona un live event con Mux via API.
   * Para Vimeo, las credenciales se ingresan manualmente en PUT /livekit/config.
   */
  @Post('provision')
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
        'Solo Mux se auto-provisiona. Para Vimeo, ingresa las credenciales manualmente en la configuración.',
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
  async setConfig(
    @Body()
    body: {
      eventSlug: string;
      ingestProtocol?: 'rtmp' | 'srt';
      rtmpServerUrl?: string;
      rtmpStreamKey?: string;
      srtIngestUrl?: string;
      playbackHlsUrl?: string;
      layout?: 'grid' | 'speaker';
      showFrame?: boolean;
      frameUrl?: string;
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

    const saved = await this.liveConfig.update(body.eventSlug, patch);
    return { ok: true, id: saved._id, allowSecrets };
  }

  @Get('config')
  async getConfig(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    const cfg = await this.liveConfig.getOrCreate(eventSlug);

    if (!cfg) {
      throw new BadRequestException(
        'No se encontró configuración para el evento',
      );
    }

    // MVP: enmascarar secretos para UI
    return {
      eventSlug: cfg.eventSlug,
      provider: cfg.provider || 'mux',
      providerStreamId: cfg.providerStreamId || '',
      ingestProtocol: cfg.ingestProtocol,
      rtmpServerUrl: cfg.rtmpServerUrl,
      rtmpStreamKey: cfg.rtmpStreamKey ? '****' : '',
      srtIngestUrl: cfg.srtIngestUrl ? '****' : '',
      playbackHlsUrl: cfg.playbackHlsUrl,
      layout: cfg.layout,
      maxParticipants: cfg.maxParticipants,
      status: cfg.status,
      activeEgressId: cfg.activeEgressId,
      lastError: cfg.lastError,
      showFrame: !!cfg.showFrame,
      frameUrl: cfg.frameUrl || '',
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
      mediaMuted: true,
      mediaLoop: false,
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
   * GET /livekit/replay?eventSlug=xxx
   * Obtiene la URL de repetición del live stream (solo Mux).
   * Mux crea automáticamente un Asset (video grabado) cuando termina el stream.
   */
  @Get('replay')
  async getReplayUrl(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    const cfg = await this.liveConfig.get(eventSlug);

    if (!cfg.providerStreamId || cfg.provider !== 'mux') {
      return {
        ok: false,
        status: 'not_available',
        message: 'Este evento no tiene un stream de Mux provisionado.',
      };
    }

    const result = await this.muxService.getReplayUrl(cfg.providerStreamId);
    return {
      ok: result.status === 'ready',
      provider: 'mux',
      ...result,
    };
  }

  /**
   * GET /livekit/stream-info?eventSlug=xxx
   * Obtiene información del live stream de Mux (status, assets, etc.)
   */
  @Get('stream-info')
  async getStreamInfo(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    const cfg = await this.liveConfig.get(eventSlug);

    if (cfg.provider !== 'mux' || !cfg.providerStreamId) {
      return {
        ok: false,
        message: 'No hay stream de Mux configurado para este evento.',
      };
    }

    const info = await this.muxService.getLiveStreamInfo(cfg.providerStreamId);

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
   * Lista todas las grabaciones (assets) disponibles para un evento (solo Mux).
   */
  @Get('assets')
  async listAssets(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');

    const cfg = await this.liveConfig.get(eventSlug);

    if (!cfg.providerStreamId || cfg.provider !== 'mux') {
      return {
        ok: false,
        assets: [],
        message: 'Este evento no tiene un stream de Mux provisionado.',
      };
    }

    const result = await this.muxService.listAssets(cfg.providerStreamId);
    return { ok: true, provider: 'mux', ...result };
  }

  /**
   * GET /livekit/replay-by-asset?eventSlug=xxx&assetId=yyy
   * Obtiene la URL de repetición de un asset específico
   */
  @Get('replay-by-asset')
  async getReplayByAsset(
    @Query('eventSlug') eventSlug: string,
    @Query('assetId') assetId: string,
  ) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    if (!assetId) throw new BadRequestException('assetId requerido');

    // Verificar que el evento usa Mux
    const cfg = await this.liveConfig.get(eventSlug);

    if (cfg.provider !== 'mux') {
      return {
        ok: false,
        status: 'not_available',
        message: 'Este evento no usa Mux como proveedor.',
      };
    }

    const result = await this.muxService.getReplayUrlByAssetId(assetId);

    return {
      ok: result.status === 'ready',
      ...result,
    };
  }
}
