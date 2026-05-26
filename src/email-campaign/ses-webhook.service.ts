import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { HydratedDocument, Model, Types } from 'mongoose';
import {
  EmailDelivery,
  EmailDeliveryDocument,
} from './schemas/email-delivery.schema';
import {
  EmailCampaign,
  EmailCampaignDocument,
} from './schemas/email-campaign.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';

type OrgAttendeeDocument = HydratedDocument<OrgAttendee>;

@Injectable()
export class SesWebhookService {
  private readonly logger = new Logger(SesWebhookService.name);
  private readonly expectedTopicArn: string | undefined;

  constructor(
    @InjectModel(EmailDelivery.name)
    private readonly deliveryModel: Model<EmailDeliveryDocument>,
    @InjectModel(EmailCampaign.name)
    private readonly campaignModel: Model<EmailCampaignDocument>,
    @InjectModel(OrgAttendee.name)
    private readonly attendeeModel: Model<OrgAttendeeDocument>,
    private readonly configService: ConfigService,
  ) {
    this.expectedTopicArn = this.configService.get<string>('AWS_SNS_TOPIC_ARN');
  }

  async handleSnsPayload(payload: Record<string, any>): Promise<void> {
    const type: string = payload?.Type;
    this.logger.log(`SNS payload recibido: Type=${type}, TopicArn=${payload?.TopicArn ?? 'n/a'}`);

    // Validar que el mensaje viene del topic correcto (si está configurado)
    if (
      this.expectedTopicArn &&
      payload?.TopicArn !== this.expectedTopicArn
    ) {
      this.logger.warn(
        `SES webhook: TopicArn inesperado (${payload?.TopicArn}), ignorando`,
      );
      return;
    }

    if (type === 'SubscriptionConfirmation') {
      await this.confirmSubscription(payload.SubscribeURL as string);
      return;
    }

    if (type !== 'Notification') return;

    let message: Record<string, any>;
    try {
      message = JSON.parse(payload.Message as string);
    } catch {
      this.logger.warn('SES webhook: no se pudo parsear Message');
      return;
    }

    const notificationType: string = message.notificationType;
    this.logger.log(`SNS notificación recibida: ${notificationType}`);

    if (notificationType === 'Bounce') {
      await this.handleBounce(message);
    } else if (notificationType === 'Complaint') {
      await this.handleComplaint(message);
    }
  }

  // ─── Bounce ────────────────────────────────────────────────────────────────

  private async handleBounce(message: Record<string, any>): Promise<void> {
    const sesMessageId: string = message.mail?.messageId;
    if (!sesMessageId) return;

    const bounceType: string = message.bounce?.bounceType; // 'Permanent' | 'Transient'
    const bounceSubType: string = message.bounce?.bounceSubType ?? '';
    const bouncedEmails: string[] = (
      (message.bounce?.bouncedRecipients as any[]) ?? []
    ).map((r) => r.emailAddress as string);

    this.logger.log(
      `Bounce ${bounceType}/${bounceSubType} para sesMessageId=${sesMessageId} — emails: ${bouncedEmails.join(', ')}`,
    );

    // Actualizar deliveries por sesMessageId
    const deliveries = await this.deliveryModel
      .find({ sesMessageId })
      .lean<EmailDeliveryDocument[]>();

    for (const delivery of deliveries) {
      const deliveryId = (delivery._id as Types.ObjectId).toString();
      const campaignId = delivery.campaignId.toString();

      await this.deliveryModel.findByIdAndUpdate(deliveryId, {
        status: 'bounced',
        errorMessage: `${bounceType}/${bounceSubType}`.slice(0, 500),
      });

      // Corregir contador: sent → bounced en las stats de la campaña
      await this.campaignModel.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.bounced': 1, 'stats.sent': -1 },
      });
    }

    // Solo hard bounce suprime el email en la base de datos
    if (bounceType === 'Permanent') {
      for (const email of bouncedEmails) {
        await this.attendeeModel.updateMany(
          { email },
          {
            emailStatus: 'bounced',
            emailBounceType: 'Permanent',
            emailSuppressedAt: new Date(),
            emailSuppressReason: `Hard bounce (${bounceSubType})`,
          },
        );
      }
    }
  }

  // ─── Complaint ─────────────────────────────────────────────────────────────

  private async handleComplaint(message: Record<string, any>): Promise<void> {
    const sesMessageId: string = message.mail?.messageId;
    if (!sesMessageId) return;

    const feedbackType: string =
      message.complaint?.complaintFeedbackType ?? 'unknown';
    const complainedEmails: string[] = (
      (message.complaint?.complainedRecipients as any[]) ?? []
    ).map((r) => r.emailAddress as string);

    this.logger.log(
      `Complaint (${feedbackType}) para sesMessageId=${sesMessageId} — emails: ${complainedEmails.join(', ')}`,
    );

    const deliveries = await this.deliveryModel
      .find({ sesMessageId })
      .lean<EmailDeliveryDocument[]>();

    for (const delivery of deliveries) {
      const deliveryId = (delivery._id as Types.ObjectId).toString();
      const campaignId = delivery.campaignId.toString();

      await this.deliveryModel.findByIdAndUpdate(deliveryId, {
        status: 'complained',
        errorMessage: `Complaint: ${feedbackType}`.slice(0, 500),
      });

      await this.campaignModel.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.complained': 1, 'stats.sent': -1 },
      });
    }

    // Todo complaint suprime el email (el destinatario marcó como spam)
    for (const email of complainedEmails) {
      await this.attendeeModel.updateMany(
        { email },
        {
          emailStatus: 'complained',
          emailBounceType: null,
          emailSuppressedAt: new Date(),
          emailSuppressReason: `Spam complaint (${feedbackType})`,
        },
      );
    }
  }

  // ─── SNS subscription confirm ──────────────────────────────────────────────

  private async confirmSubscription(subscribeUrl: string): Promise<void> {
    try {
      await fetch(subscribeUrl);
      this.logger.log('SNS subscription confirmada correctamente');
    } catch (err) {
      this.logger.error('Error confirmando suscripción SNS', err);
    }
  }
}
