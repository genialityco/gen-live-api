import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { HydratedDocument, Model, Types } from 'mongoose';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EmailCampaign,
  EmailCampaignDocument,
} from './schemas/email-campaign.schema';
import {
  EmailDelivery,
  EmailDeliveryDocument,
} from './schemas/email-delivery.schema';
import { ConfigService } from '@nestjs/config';
import { Event, EventDocument } from '../events/schemas/event.schema';
import { EventUser } from '../events/schemas/event-user.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  EventEmailTemplate,
  EventEmailTemplateDocument,
} from '../event-email/schemas/event-email-template.schema';

type EventUserDocument = HydratedDocument<EventUser>;
type OrgAttendeeDocument = HydratedDocument<OrgAttendee>;
import { EmailVariableService } from '../event-email/email-variable.service';
import { MailService } from '../mail/mail.service';
import { CreateCampaignDto } from './dtos/create-campaign.dto';
import { ListDeliveriesDto } from './dtos/list-deliveries.dto';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 750; // ~13 emails/seg, bajo el límite de SES 14/seg

@Injectable()
export class EmailCampaignService implements OnModuleInit {
  private readonly logger = new Logger(EmailCampaignService.name);
  private readonly sendingCampaigns = new Set<string>();
  private wrapperTemplate: HandlebarsTemplateDelegate | null = null;

  constructor(
    @InjectModel(EmailCampaign.name)
    private readonly campaignModel: Model<EmailCampaignDocument>,
    @InjectModel(EmailDelivery.name)
    private readonly deliveryModel: Model<EmailDeliveryDocument>,
    @InjectModel(EventUser.name)
    private readonly eventUserModel: Model<EventUserDocument>,
    @InjectModel(OrgAttendee.name)
    private readonly orgAttendeeModel: Model<OrgAttendeeDocument>,
    @InjectModel(Organization.name)
    private readonly orgModel: Model<OrganizationDocument>,
    @InjectModel(EventEmailTemplate.name)
    private readonly templateModel: Model<EventEmailTemplateDocument>,
    private readonly variableService: EmailVariableService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
  ) {}

  // ─── Startup recovery ──────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    const stuck = await this.campaignModel
      .find({ status: 'sending' })
      .lean<EmailCampaignDocument[]>();

    if (stuck.length === 0) return;

    this.logger.warn(
      `Recuperando ${stuck.length} campaña(s) que quedaron en estado 'sending'`,
    );

    for (const campaign of stuck) {
      const campaignId = (campaign._id as Types.ObjectId).toString();
      setImmediate(() => void this.processSend(campaignId));
    }
  }

  // ─── Template wrapper ──────────────────────────────────────────────────────

  private getWrapperTemplate(): HandlebarsTemplateDelegate {
    if (!this.wrapperTemplate) {
      const filePath = join(
        __dirname,
        '..',
        'mail',
        'templates',
        'event-email-wrapper.hbs',
      );
      const source = readFileSync(filePath, 'utf-8');
      this.wrapperTemplate = Handlebars.compile(source);
    }
    return this.wrapperTemplate;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async createCampaign(
    dto: CreateCampaignDto,
    createdBy: string,
  ): Promise<EmailCampaignDocument> {
    const campaign = await this.campaignModel.create({
      orgId: new Types.ObjectId(dto.orgId),
      eventId: new Types.ObjectId(dto.eventId),
      name: dto.name,
      templateId: new Types.ObjectId(dto.templateId),
      targetAudience: dto.targetAudience,
      audienceFilters: dto.audienceFilters ?? null,
      utmParams: dto.utmParams ?? null,
      excludeEventUsers: dto.excludeEventUsers ?? false,
      status: 'draft',
      createdBy,
    });
    return campaign;
  }

  async listCampaigns(
    orgId: string,
    eventId: string,
  ): Promise<EmailCampaignDocument[]> {
    return this.campaignModel
      .find({
        orgId: new Types.ObjectId(orgId),
        eventId: new Types.ObjectId(eventId),
      })
      .sort({ createdAt: -1 })
      .lean<EmailCampaignDocument[]>();
  }

  async getCampaign(campaignId: string): Promise<EmailCampaignDocument> {
    const campaign = await this.campaignModel
      .findById(campaignId)
      .lean<EmailCampaignDocument>();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    return campaign;
  }

  async cancelCampaign(campaignId: string): Promise<void> {
    const campaign = await this.campaignModel
      .findById(campaignId)
      .select('status')
      .lean();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');

    const nonCancellable = ['completed', 'failed', 'cancelled'];
    if (nonCancellable.includes(campaign.status)) {
      throw new BadRequestException(
        `No se puede cancelar una campaña en estado '${campaign.status}'`,
      );
    }

    await this.campaignModel.findByIdAndUpdate(campaignId, {
      status: 'cancelled',
    });
  }

  // ─── Deliveries ────────────────────────────────────────────────────────────

  async listDeliveries(
    campaignId: string,
    dto: ListDeliveriesDto,
  ): Promise<{ data: EmailDeliveryDocument[]; total: number }> {
    const filter: Record<string, unknown> = {
      campaignId: new Types.ObjectId(campaignId),
    };
    if (dto.status) filter.status = dto.status;

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 50;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.deliveryModel
        .find(filter)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: 1 })
        .lean<EmailDeliveryDocument[]>(),
      this.deliveryModel.countDocuments(filter),
    ]);

    return { data, total };
  }

  async exportDeliveriesCsv(campaignId: string): Promise<string> {
    const deliveries = await this.deliveryModel
      .find({ campaignId: new Types.ObjectId(campaignId) })
      .sort({ createdAt: 1 })
      .lean<EmailDeliveryDocument[]>();

    const header = 'Email,Nombre,Estado,Fecha envío,Error\n';
    const rows = deliveries.map((d) => {
      const sentAt = d.sentAt
        ? new Date(d.sentAt).toISOString()
        : '';
      const error = (d.errorMessage ?? '').replace(/"/g, '""');
      return `"${d.email}","${d.name}","${d.status}","${sentAt}","${error}"`;
    });

    return header + rows.join('\n');
  }

  // ─── Envío ─────────────────────────────────────────────────────────────────

  async sendCampaign(campaignId: string): Promise<{ total: number }> {
    const campaign = await this.campaignModel.findById(campaignId);
    if (!campaign) throw new NotFoundException('Campaña no encontrada');

    if (campaign.status === 'sending') {
      throw new ConflictException('La campaña ya está en proceso de envío');
    }

    if (this.sendingCampaigns.has(campaignId)) {
      throw new ConflictException('La campaña ya está en proceso de envío');
    }

    // Cargar template para snapshot
    const template = await this.templateModel
      .findById(campaign.templateId)
      .lean<EventEmailTemplateDocument>();

    if (!template) {
      throw new BadRequestException(
        'La plantilla asociada a la campaña no existe',
      );
    }

    if (!template.enabled) {
      throw new BadRequestException('La plantilla está deshabilitada');
    }

    // Resolver destinatarios
    const recipients = await this.resolveRecipients(campaign);
    const total = recipients.length;

    if (total === 0) {
      throw new BadRequestException(
        'No se encontraron destinatarios para esta campaña',
      );
    }

    // Guardar snapshot del template y crear deliveries
    await campaign.updateOne({
      templateSnapshot: {
        subject: template.subject,
        body: template.body,
      },
      status: 'sending',
      startedAt: new Date(),
      'stats.total': total,
      'stats.pending': total,
      'stats.sent': 0,
      'stats.rejected': 0,
      'stats.failed': 0,
      'stats.bounced': 0,
      'stats.complained': 0,
    });

    // Bulk insert de deliveries en estado pending
    const deliveryDocs = recipients.map((r) => ({
      campaignId: campaign._id,
      orgId: campaign.orgId,
      eventId: campaign.eventId,
      attendeeId: new Types.ObjectId(r.attendeeId),
      eventUserId: r.eventUserId ? new Types.ObjectId(r.eventUserId) : null,
      email: r.email,
      name: r.name,
      status: 'pending',
      sesMessageId: null,
      errorMessage: null,
      sentAt: null,
    }));

    await this.deliveryModel.insertMany(deliveryDocs, { ordered: false });

    this.logger.log(
      `Campaña ${campaignId} iniciada — ${total} destinatarios`,
    );

    // Fire-and-forget: enviar en background
    setImmediate(() => {
      void this.processSend(campaignId);
    });

    return { total };
  }

  async resumeCampaign(campaignId: string): Promise<{ pending: number }> {
    if (this.sendingCampaigns.has(campaignId)) {
      throw new ConflictException('La campaña ya está en proceso de envío');
    }

    const pendingCount = await this.deliveryModel.countDocuments({
      campaignId: new Types.ObjectId(campaignId),
      status: 'pending',
    });

    if (pendingCount === 0) {
      throw new BadRequestException('No hay entregas pendientes para reanudar');
    }

    await this.campaignModel.findByIdAndUpdate(campaignId, {
      status: 'sending',
    });

    setImmediate(() => {
      void this.processSend(campaignId);
    });

    return { pending: pendingCount };
  }

  // ─── iCal ──────────────────────────────────────────────────────────────────

  private buildIcal(
    event: EventDocument,
    campaignId: string,
    frontendUrl: string,
    orgSlug: string,
  ): string | null {
    if (!event.schedule?.startsAt) return null;

    const formatDate = (d: Date): string =>
      d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

    const startsAt = new Date(event.schedule.startsAt);
    const endsAt = event.schedule.endsAt
      ? new Date(event.schedule.endsAt)
      : new Date(startsAt.getTime() + 60 * 60 * 1000);

    const dtstamp = formatDate(new Date());
    const uid = `${campaignId}-${(event._id as Types.ObjectId).toString()}@geniality.io`;
    const eventUrl = `${frontendUrl}/org/${orgSlug}/event/${event.slug}`;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Gen.iality//Live Events//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${formatDate(startsAt)}`,
      `DTEND:${formatDate(endsAt)}`,
      `SUMMARY:${this.escapeIcal(event.title)}`,
      `URL:${eventUrl}`,
    ];

    if (event.description) {
      lines.push(`DESCRIPTION:${this.escapeIcal(event.description)}`);
    }

    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
  }

  private escapeIcal(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  // ─── Loop de envío interno ─────────────────────────────────────────────────

  private async processSend(campaignId: string): Promise<void> {
    if (this.sendingCampaigns.has(campaignId)) return;
    this.sendingCampaigns.add(campaignId);

    try {
      const campaign = await this.campaignModel.findById(campaignId).lean();
      if (!campaign || !campaign.templateSnapshot) {
        this.logger.error(
          `processSend: campaña ${campaignId} no tiene snapshot`,
        );
        return;
      }

      const org = await this.orgModel
        .findById(campaign.orgId)
        .lean<Organization>();
      const wrapper = this.getWrapperTemplate();
      const orgId = campaign.orgId.toString();
      const eventId = campaign.eventId.toString();

      // Compilar templates una sola vez para toda la campaña
      const compiledSubject = Handlebars.compile(campaign.templateSnapshot.subject);
      const compiledBody = Handlebars.compile(campaign.templateSnapshot.body);

      // Generar iCal una sola vez para toda la campaña
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '';
      const event = await this.eventModel.findById(campaign.eventId).lean<EventDocument>();
      const icalContent = event
        ? this.buildIcal(event, campaignId, frontendUrl, org?.domainSlug ?? '')
        : null;

      // Procesar en batches todos los deliveries pendientes
      let hasMore = true;
      while (hasMore) {
        // Verificar si la campaña fue cancelada
        const current = await this.campaignModel
          .findById(campaignId)
          .select('status')
          .lean();
        if (current?.status === 'cancelled') {
          this.logger.log(`Campaña ${campaignId} cancelada — deteniendo envío`);
          break;
        }

        const batch = await this.deliveryModel
          .find({ campaignId: new Types.ObjectId(campaignId), status: 'pending' })
          .limit(BATCH_SIZE)
          .lean<EmailDeliveryDocument[]>();

        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        await Promise.all(
          batch.map((delivery) =>
            this.sendOneEmail(
              delivery,
              compiledSubject,
              compiledBody,
              orgId,
              eventId,
              org?.name,
              wrapper,
              icalContent,
              campaign.utmParams,
            ),
          ),
        );

        if (batch.length === BATCH_SIZE) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }

      // Verificar estado final
      const finalCampaign = await this.campaignModel
        .findById(campaignId)
        .select('status')
        .lean();

      if (finalCampaign?.status !== 'cancelled') {
        await this.campaignModel.findByIdAndUpdate(campaignId, {
          status: 'completed',
          completedAt: new Date(),
        });
        this.logger.log(`Campaña ${campaignId} completada`);
      }
    } catch (err) {
      this.logger.error(`Error fatal en campaña ${campaignId}`, err);
      await this.campaignModel.findByIdAndUpdate(campaignId, {
        status: 'failed',
      });
    } finally {
      this.sendingCampaigns.delete(campaignId);
    }
  }

  private async sendOneEmail(
    delivery: EmailDeliveryDocument,
    compiledSubject: HandlebarsTemplateDelegate,
    compiledBody: HandlebarsTemplateDelegate,
    orgId: string,
    eventId: string,
    fromName: string | undefined,
    wrapper: HandlebarsTemplateDelegate,
    icalContent: string | null = null,
    utmConfig?: any,
  ): Promise<void> {
    const deliveryId = (delivery._id as Types.ObjectId).toString();
    const campaignId = delivery.campaignId.toString();

    try {
      const context = await this.variableService.buildContext(
        orgId,
        eventId,
        delivery.attendeeId.toString(),
        delivery.eventUserId?.toString(),
        undefined,
        utmConfig,
      );

      const renderedSubject = compiledSubject(context);
      const renderedBody = compiledBody(context);
      const wrappedHtml = wrapper({ ...context, content: renderedBody });

      const { messageId } = icalContent
        ? await this.mailService.sendRawEmailWithIcal({
            to: delivery.email,
            subject: renderedSubject,
            htmlBody: wrappedHtml,
            fromName,
            icalContent,
          })
        : await this.mailService.sendRawHtmlEmail({
            to: delivery.email,
            subject: renderedSubject,
            htmlBody: wrappedHtml,
            fromName,
          });

      await this.deliveryModel.findByIdAndUpdate(deliveryId, {
        status: 'sent',
        sesMessageId: messageId,
        sentAt: new Date(),
      });

      await this.campaignModel.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.sent': 1, 'stats.pending': -1 },
      });
    } catch (err: unknown) {
      const isRejected =
        err instanceof Error && err.name === 'MessageRejected';
      const status = isRejected ? 'rejected' : 'failed';
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      this.logger.warn(
        `Email ${status} para ${delivery.email}: ${errorMessage}`,
      );

      await this.deliveryModel.findByIdAndUpdate(deliveryId, {
        status,
        errorMessage: errorMessage.slice(0, 500),
      });

      const statsKey = isRejected ? 'stats.rejected' : 'stats.failed';
      await this.campaignModel.findByIdAndUpdate(campaignId, {
        $inc: { [statsKey]: 1, 'stats.pending': -1 },
      });
    }
  }

  // ─── Resolución de destinatarios ───────────────────────────────────────────

  private async resolveRecipients(campaign: EmailCampaignDocument): Promise<
    Array<{
      attendeeId: string;
      eventUserId?: string;
      email: string;
      name: string;
    }>
  > {
    const recipientMap = new Map<
      string,
      { attendeeId: string; eventUserId?: string; email: string; name: string }
    >();

    const orgId = campaign.orgId.toString();
    const eventId = campaign.eventId.toString();
    const audience = campaign.targetAudience;

    // Emails con bounces permanentes o complaints se excluyen del envío
    const suppressedFilter = { emailStatus: { $nin: ['bounced', 'complained'] } };

    if (audience === 'event_users' || audience === 'both') {
      const statusFilter =
        campaign.audienceFilters?.eventUserStatus &&
        campaign.audienceFilters.eventUserStatus.length > 0
          ? { status: { $in: campaign.audienceFilters.eventUserStatus } }
          : {};

      const eventUsers = await this.eventUserModel
        .find({ eventId, ...statusFilter })
        .populate<{ attendeeId: OrgAttendeeDocument }>({
          path: 'attendeeId',
          match: suppressedFilter,
        })
        .lean();

      for (const eu of eventUsers) {
        const attendee = eu.attendeeId as unknown as OrgAttendeeDocument;
        if (!attendee?.email) continue;
        recipientMap.set(attendee.email, {
          attendeeId: (attendee._id as Types.ObjectId).toString(),
          eventUserId: (eu._id as Types.ObjectId).toString(),
          email: attendee.email,
          name: attendee.name ?? attendee.email,
        });
      }
    }

    if (audience === 'org_attendees' || audience === 'both') {
      // Si excludeEventUsers, construir el set de emails ya registrados al evento
      let eventUserEmailSet: Set<string> | null = null;
      if (campaign.excludeEventUsers) {
        const registeredUsers = await this.eventUserModel
          .find({ eventId })
          .populate<{ attendeeId: OrgAttendeeDocument }>({
            path: 'attendeeId',
            select: 'email',
          })
          .lean();
        eventUserEmailSet = new Set(
          registeredUsers
            .map((eu) => (eu.attendeeId as unknown as OrgAttendeeDocument)?.email)
            .filter(Boolean) as string[],
        );
      }

      const orgAttendees = await this.orgAttendeeModel
        .find({ organizationId: orgId, ...suppressedFilter })
        .lean<OrgAttendeeDocument[]>();

      for (const a of orgAttendees) {
        if (!a.email) continue;
        if (recipientMap.has(a.email)) continue;
        if (eventUserEmailSet?.has(a.email)) continue;
        recipientMap.set(a.email, {
          attendeeId: (a._id as Types.ObjectId).toString(),
          email: a.email,
          name: a.name ?? a.email,
        });
      }
    }

    return Array.from(recipientMap.values());
  }

  async listSuppressedAttendees(
    orgId: string,
  ): Promise<
    {
      _id: string;
      email: string;
      name: string;
      emailStatus: string;
      emailBounceType: string | null;
      emailSuppressedAt: Date | null;
      emailSuppressReason: string | null;
    }[]
  > {
    const docs = await this.orgAttendeeModel
      .find({
        organizationId: orgId,
        emailStatus: { $in: ['bounced', 'complained'] },
      })
      .select(
        '_id email name emailStatus emailBounceType emailSuppressedAt emailSuppressReason',
      )
      .sort({ emailSuppressedAt: -1 })
      .lean<OrgAttendeeDocument[]>();

    return docs.map((d) => ({
      _id: (d._id as Types.ObjectId).toString(),
      email: d.email,
      name: d.name,
      emailStatus: d.emailStatus ?? 'valid',
      emailBounceType: (d as any).emailBounceType ?? null,
      emailSuppressedAt: (d as any).emailSuppressedAt ?? null,
      emailSuppressReason: (d as any).emailSuppressReason ?? null,
    }));
  }

  async restoreAttendeeEmail(attendeeId: string): Promise<void> {
    await this.orgAttendeeModel.findByIdAndUpdate(attendeeId, {
      emailStatus: 'valid',
      emailBounceType: null,
      emailSuppressedAt: null,
      emailSuppressReason: null,
    });
  }

  async deleteByEventId(eventId: string): Promise<void> {
    const oid = new Types.ObjectId(eventId);
    const campaigns = await this.campaignModel
      .find({ eventId: oid }, { _id: 1 })
      .lean();
    const campaignIds = campaigns.map((c) => c._id);
    if (campaignIds.length > 0) {
      await this.deliveryModel.deleteMany({ campaignId: { $in: campaignIds } });
    }
    await this.campaignModel.deleteMany({ eventId: oid });
  }
}
