import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WaDelivery, WaDeliveryDocument } from './schemas/wa-delivery.schema';
import { WaCampaign } from './schemas/wa-campaign.schema';
import { WaTemplateService } from './wa-template.service';
import { GeoipService } from '../geoip/geoip.service';

@Injectable()
export class WaWebhookService {
  private readonly logger = new Logger(WaWebhookService.name);

  constructor(
    @InjectModel(WaDelivery.name)
    private readonly deliveryModel: Model<WaDeliveryDocument>,
    @InjectModel(WaCampaign.name)
    private readonly campaignModel: Model<any>,
    private readonly templateService: WaTemplateService,
    private readonly geoipService: GeoipService,
  ) {}

  /**
   * Procesa el payload que Meta envía al webhook.
   * Meta puede incluir múltiples entries/changes en un solo POST.
   */
  async handlePayload(payload: any): Promise<void> {
    const entries: any[] = payload?.entry ?? [];

    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;

        // Cambios de estado de mensajes (sent, delivered, read, failed)
        for (const status of value?.statuses ?? []) {
          await this.handleMessageStatus(status).catch((err) =>
            this.logger.error(`Error procesando status ${status?.id}: ${err.message}`),
          );
        }

        // Cambios de estado de templates (approved, rejected, etc.)
        for (const tmpl of value?.message_template_status_update
          ? [value.message_template_status_update]
          : []) {
          await this.handleTemplateStatus(tmpl).catch((err) =>
            this.logger.error(`Error procesando template status: ${err.message}`),
          );
        }
      }
    }
  }

  // ─── Message status ───────────────────────────────────────────────────────

  private async handleMessageStatus(status: any): Promise<void> {
    const waMessageId: string = status?.id;
    const metaStatus: string = status?.status; // sent | delivered | read | failed
    const timestamp: number = parseInt(status?.timestamp ?? '0', 10);

    if (!waMessageId || !metaStatus) return;

    const delivery = await this.deliveryModel
      .findOne({ waMessageId })
      .lean();

    if (!delivery) return;

    const update: Record<string, any> = {};
    const campaignInc: Record<string, number> = {};

    switch (metaStatus) {
      case 'sent':
        if (delivery.status === 'pending') {
          update.status = 'sent';
          update.sentAt = new Date(timestamp * 1000);
          campaignInc['stats.sent'] = 1;
          campaignInc['stats.pending'] = -1;
        }
        break;

      case 'delivered':
        if (delivery.status !== 'delivered' && delivery.status !== 'read') {
          update.status = 'delivered';
          update.deliveredAt = new Date(timestamp * 1000);
          campaignInc['stats.delivered'] = 1;
        }
        break;

      case 'read':
        if (delivery.status !== 'read') {
          update.status = 'read';
          update.readAt = new Date(timestamp * 1000);
          if (delivery.status !== 'delivered') {
            campaignInc['stats.delivered'] = 1;
          }
          campaignInc['stats.read'] = 1;
        }
        break;

      case 'failed': {
        const errorCode: number = status?.errors?.[0]?.code;
        const errorMsg: string = status?.errors?.[0]?.message ?? 'Error desconocido';
        update.status = 'failed';
        update.errorMessage = errorMsg;
        update.errorCode = errorCode;
        campaignInc['stats.failed'] = 1;
        if (delivery.status === 'pending') campaignInc['stats.pending'] = -1;

        // Opted-out: código 131026 en Meta
        if (errorCode === 131026) {
          update.status = 'opted_out';
          campaignInc['stats.optedOut'] = 1;
          delete campaignInc['stats.failed'];
          await this.markAttendeeOptedOut(delivery.attendeeId.toString());
        }
        break;
      }
    }

    if (Object.keys(update).length > 0) {
      await this.deliveryModel.findByIdAndUpdate(delivery._id, { $set: update });
    }

    if (Object.keys(campaignInc).length > 0) {
      await this.campaignModel.findByIdAndUpdate(delivery.campaignId, {
        $inc: campaignInc,
      });
    }
  }

  // ─── Template status ──────────────────────────────────────────────────────

  private async handleTemplateStatus(data: any): Promise<void> {
    const metaTemplateId: string = data?.message_template_id?.toString();
    const status: string = data?.event; // APPROVED, REJECTED, DISABLED, etc.
    const reason: string | undefined = data?.reason;

    if (!metaTemplateId || !status) return;

    await this.templateService.handleStatusUpdate(metaTemplateId, status, reason);
    this.logger.log(`Template ${metaTemplateId} → ${status}`);
  }

  // ─── Click tracking ───────────────────────────────────────────────────────

  /**
   * Registra la llegada/clic del destinatario al link de WhatsApp.
   * El token es el deliveryId en base64url (mismo patrón que email tracking).
   * A diferencia de email, el link de WhatsApp va directo a la página de destino
   * (sin redirect), así que la IP del destinatario solo llega aquí: la usamos
   * para geolocalizar el país de origen del clic.
   */
  async recordArrival(token: string, ip = ''): Promise<void> {
    let deliveryId: string;
    try {
      deliveryId = Buffer.from(token, 'base64url').toString('utf8');
      if (!Types.ObjectId.isValid(deliveryId)) return;
    } catch {
      return;
    }

    const delivery = await this.deliveryModel.findById(deliveryId).lean();
    if (!delivery) return;

    const isFirstClick = (delivery.clickCount ?? 0) === 0;

    const set: Record<string, any> = {};
    if (isFirstClick) set.firstClickAt = new Date();
    // Resuelve el país solo si aún no lo tenemos (primer clic con IP válida);
    // guarda también la IP para poder hacer backfill si la geo se activa luego.
    if (ip && !delivery.geoCountry) {
      set.clickIp = ip;
      const iso = this.geoipService.lookupCountry(ip)?.iso ?? null;
      if (iso) set.geoCountry = iso;
    }

    await this.deliveryModel.findByIdAndUpdate(deliveryId, {
      $inc: { clickCount: 1 },
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
    });

    const campaignInc: Record<string, number> = { 'stats.totalClicks': 1 };
    if (isFirstClick) campaignInc['stats.clicked'] = 1;
    await this.campaignModel.findByIdAndUpdate(delivery.campaignId, {
      $inc: campaignInc,
    });
  }

  private async markAttendeeOptedOut(attendeeId: string): Promise<void> {
    try {
      await this.deliveryModel.db
        .model('OrgAttendee')
        .findByIdAndUpdate(attendeeId, { $set: { phoneStatus: 'opted_out' } });
    } catch {
      // No crítico
    }
  }
}
