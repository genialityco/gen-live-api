import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Param,
  Req,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { WaWebhookService } from './wa-webhook.service';

@Controller('wa')
export class WaWebhookController {
  private readonly logger = new Logger(WaWebhookController.name);
  private readonly verifyToken: string;

  constructor(
    private readonly webhookService: WaWebhookService,
    configService: ConfigService,
  ) {
    this.verifyToken = configService.getOrThrow<string>('WA_WEBHOOK_VERIFY_TOKEN');
  }

  /** Meta verifica el webhook con un GET al configurarlo */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === this.verifyToken) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Forbidden');
    }
  }

  /** Meta envía eventos de mensajes y templates aquí */
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Body() payload: any) {
    // Meta espera 200 rápido — procesamos async
    this.webhookService.handlePayload(payload).catch((err) =>
      this.logger.error(`Webhook error: ${err.message}`),
    );
    return { ok: true };
  }

  /** Confirmación de llegada al hacer clic en el link de WhatsApp (mismo patrón que el _tc de email) */
  @Get('track/arrive/:token')
  @HttpCode(204)
  async trackArrival(
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<void> {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';
    await this.webhookService.recordArrival(token, ip);
  }
}
