import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WaCampaign, WaCampaignDocument } from './schemas/wa-campaign.schema';
import { WaCampaignService } from './wa-campaign.service';
import { WaAutoRuleService } from './wa-auto-rule.service';
import { AUTO_SEND_TICK_MS, autoSendStep } from './wa-audience';

/**
 * Envío automático de campañas de WhatsApp al pasar el evento a diferido
 * (por ejemplo, invitar a ver la grabación a los inscritos que no asistieron).
 *
 * Cada minuto crea las campañas de las reglas automáticas (WaAutoRuleService)
 * y revisa las campañas en `draft` con `autoSend` sin disparar.
 * La hora de envío y el disparo se guardan en Mongo, así que un reinicio del
 * servidor no pierde ni repite envíos; con varias instancias, el disparo se
 * reclama con una actualización atómica sobre `autoSend.firedAt`.
 */
@Injectable()
export class WaAutoSendService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WaAutoSendService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectModel(WaCampaign.name)
    private readonly campaignModel: Model<WaCampaignDocument>,
    @InjectModel('Event')
    private readonly eventModel: Model<any>,
    private readonly campaignService: WaCampaignService,
    private readonly autoRuleService: WaAutoRuleService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), AUTO_SEND_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Primero, crear las campañas de las reglas automáticas de cada
      // organización en los eventos que aún no las tienen
      await this.autoRuleService.materialize();

      const pending = await this.campaignModel
        .find(
          {
            status: 'draft',
            autoSend: { $ne: null },
            'autoSend.firedAt': null,
          },
          { eventId: 1, autoSend: 1, name: 1 },
        )
        .lean();
      if (pending.length === 0) return;

      const events = await this.eventModel
        .find(
          { _id: { $in: [...new Set(pending.map((c) => c.eventId))] } },
          { status: 1 },
        )
        .lean<{ _id: unknown; status?: string }[]>();
      const statusById = new Map(events.map((e) => [String(e._id), e.status]));

      for (const c of pending) {
        if (!c.autoSend) continue;
        const step = autoSendStep(
          c.autoSend,
          statusById.get(String(c.eventId)),
          now,
        );
        switch (step.kind) {
          case 'wait':
            break;
          case 'schedule':
            await this.campaignModel.updateOne(
              { _id: c._id, status: 'draft', 'autoSend.firedAt': null },
              { $set: { 'autoSend.dueAt': step.dueAt } },
            );
            this.logger.log(
              `[auto-send] "${c.name}" (${String(c._id)}) programada para ${step.dueAt.toISOString()}`,
            );
            break;
          case 'unschedule':
            await this.campaignModel.updateOne(
              { _id: c._id, status: 'draft', 'autoSend.firedAt': null },
              { $set: { 'autoSend.dueAt': null } },
            );
            this.logger.log(
              `[auto-send] "${c.name}" (${String(c._id)}): el evento salió de diferido, se reprograma`,
            );
            break;
          case 'fire':
            await this.fire(String(c._id), c.name, now);
            break;
        }
      }
    } catch (err) {
      this.logger.error(`[auto-send] Error en la revisión: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async fire(campaignId: string, name: string, now: Date) {
    // Reclamar el disparo: solo una instancia (y una sola vez) lo consigue
    const claimed = await this.campaignModel.findOneAndUpdate(
      { _id: campaignId, status: 'draft', 'autoSend.firedAt': null },
      { $set: { 'autoSend.firedAt': now } },
    );
    if (!claimed) return;

    try {
      const { total } = await this.campaignService.send(campaignId);
      this.logger.log(
        `[auto-send] "${name}" (${campaignId}) enviada a ${total} destinatarios`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.campaignModel.updateOne(
        { _id: campaignId },
        { $set: { 'autoSend.lastError': message } },
      );
      // Si `send` falló antes de empezar (sin destinatarios, template no
      // aprobado…) la campaña sigue en draft: se marca como fallida para que
      // no parezca pendiente. Si ya empezó, `send` maneja su propio estado.
      await this.campaignModel.updateOne(
        { _id: campaignId, status: 'draft' },
        { $set: { status: 'failed' } },
      );
      this.logger.warn(
        `[auto-send] "${name}" (${campaignId}) no se pudo enviar: ${message}`,
      );
    }
  }
}
