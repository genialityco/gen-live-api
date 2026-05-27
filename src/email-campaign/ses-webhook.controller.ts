import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { SesWebhookService } from './ses-webhook.service';

/**
 * Recibe notificaciones de AWS SNS para eventos de SES (bounces y complaints).
 * Configurar en AWS: SNS Topic → HTTP subscription → POST /mail/ses-webhook
 *
 * Este endpoint es público (sin autenticación) porque SNS no soporta Bearer tokens.
 * La verificación de origen se hace por TopicArn en el servicio (opcional via env SNS_TOPIC_ARN).
 */
@Controller('mail')
export class SesWebhookController {
  constructor(private readonly webhookService: SesWebhookService) {}

  @Post('ses-webhook')
  @HttpCode(200)
  handleSesWebhook(@Body() body: Record<string, any> | string): void {
    // SNS envía Content-Type: text/plain aunque el body sea JSON
    const payload = typeof body === 'string' ? JSON.parse(body) : body;
    // Retornar 200 de inmediato — SNS reintenta si no recibe respuesta en ~15s
    setImmediate(() => { void this.webhookService.handleSnsPayload(payload); });
  }
}
