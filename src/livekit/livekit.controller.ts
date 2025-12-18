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
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LivekitService } from './livekit.service';
import { LiveConfigService } from './live-config.service';
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
    @Inject('RTDB') private readonly rtdb: admin.database.Database,
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

    return { token };
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
    },
  ) {
    if (!body.eventSlug) throw new BadRequestException('eventSlug requerido');
    const saved = await this.liveConfig.update(body.eventSlug, body);
    return { ok: true, id: saved._id };
  }

  @Get('config')
  async getConfig(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    const cfg = await this.liveConfig.getOrCreate(eventSlug);

    // MVP: enmascarar secretos para UI
    return {
      eventSlug: cfg.eventSlug,
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
}
