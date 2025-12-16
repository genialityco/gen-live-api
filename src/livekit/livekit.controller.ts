// src/livekit/livekit.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  BadRequestException,
  Put,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LivekitService } from './livekit.service';
import { LiveConfigService } from './live-config.service';

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
}
