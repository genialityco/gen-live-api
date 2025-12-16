/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/livekit/livekit-egress.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { LivekitEgressService } from './livekit-egress.service';
import { LiveConfigService } from './live-config.service';

@Controller('live')
export class LiveController {
  constructor(
    private readonly egress: LivekitEgressService,
    private readonly liveConfig: LiveConfigService,
  ) {}

  @Post('start')
  async start(@Body() body: { eventSlug: string }) {
    const info = await this.egress.startEgress(body.eventSlug);
    return { egressId: info.egressId, status: info.status };
  }

  @Post('start-rtmp')
  async startRtmp(@Body() body: { eventSlug: string }) {
    const info = await this.egress.startEgress(body.eventSlug);
    return { egressId: info.egressId, status: info.status };
  }

  @Post('stop')
  async stop(@Body() body: { egressId: string }) {
    const info = await this.egress.stopEgress(body.egressId);
    return { egressId: info.egressId, status: info.status };
  }

  @Get('playback')
  async getPlayback(@Query('eventSlug') eventSlug?: string) {
    if (!eventSlug) throw new BadRequestException('eventSlug requerido');
    const cfg = await this.liveConfig.get(eventSlug);
    if (!cfg.playbackHlsUrl)
      throw new BadRequestException('Playback no configurado');
    return { playbackUrl: cfg.playbackHlsUrl };
  }

  @Get('status')
  async status(@Query('egressId') egressId: string) {
    const info = await this.egress.getEgress(egressId);
    return {
      status: info.status,
      error: info.error,
      errorCode: info.errorCode,
      info,
    };
  }
}
