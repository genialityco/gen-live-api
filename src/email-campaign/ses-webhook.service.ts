import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { HydratedDocument, Model, Types } from 'mongoose';
import { createVerify } from 'crypto';
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
  private readonly certCache = new Map<string, string>();

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

    // Verificar firma criptográfica de SNS antes de procesar
    const signatureValid = await this.verifySnsSignature(payload);
    if (!signatureValid) {
      this.logger.warn('SES webhook: firma SNS inválida — payload ignorado');
      return;
    }

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
    } else if (notificationType === 'Delivery') {
      await this.handleDelivery(message);
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

    // Bounce transitorio: no suprime pero loggea para detectar problemas de reputación
    if (bounceType === 'Transient') {
      const campaignId = deliveries[0]?.campaignId?.toString() ?? 'desconocida';
      this.logger.warn(
        `Bounce transitorio (${bounceSubType}) en campaña ${campaignId} — ${bouncedEmails.length} email(s): ${bouncedEmails.join(', ')}. ` +
          'Si persiste puede indicar problema de reputación o throttling del destino.',
      );
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

  // ─── Delivery ──────────────────────────────────────────────────────────────

  private async handleDelivery(message: Record<string, any>): Promise<void> {
    const sesMessageId: string = message.mail?.messageId;
    if (!sesMessageId) return;

    const recipients: string[] = (
      (message.delivery?.recipients as any[]) ?? []
    ).map((r) => String(r));

    this.logger.log(
      `SES Delivery confirmada sesMessageId=${sesMessageId} — ${recipients.join(', ')}`,
    );

    // Registra cuándo SES efectivamente entregó el email al servidor destino
    await this.deliveryModel.updateMany(
      { sesMessageId, status: 'sent' },
      { deliveredAt: new Date() },
    );
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

  // ─── Verificación de firma SNS ─────────────────────────────────────────────

  private isTrustedCertUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)
      );
    } catch {
      return false;
    }
  }

  private async fetchCert(certUrl: string): Promise<string> {
    const cached = this.certCache.get(certUrl);
    if (cached) return cached;
    const res = await fetch(certUrl);
    const pem = await res.text();
    this.certCache.set(certUrl, pem);
    return pem;
  }

  private buildStringToSign(payload: Record<string, any>): string {
    const type = payload.Type as string;
    // Los campos deben estar en orden alfabético según la spec de SNS
    const fields =
      type === 'Notification'
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

    const parts: string[] = [];
    for (const key of fields) {
      if (payload[key] !== undefined && payload[key] !== null) {
        parts.push(key, String(payload[key]));
      }
    }
    return parts.join('\n') + '\n';
  }

  private async verifySnsSignature(
    payload: Record<string, any>,
  ): Promise<boolean> {
    const certUrl = payload.SigningCertURL as string | undefined;
    const signature = payload.Signature as string | undefined;

    if (!certUrl || !signature) {
      this.logger.warn('SNS webhook: falta SigningCertURL o Signature');
      return false;
    }

    if (!this.isTrustedCertUrl(certUrl)) {
      this.logger.warn(
        `SNS webhook: SigningCertURL no es de confianza: ${certUrl}`,
      );
      return false;
    }

    try {
      const cert = await this.fetchCert(certUrl);
      const stringToSign = this.buildStringToSign(payload);
      const verify = createVerify('sha1WithRSAEncryption');
      verify.update(stringToSign);
      return verify.verify(cert, signature, 'base64');
    } catch (err) {
      this.logger.error('Error verificando firma SNS', err);
      return false;
    }
  }
}
