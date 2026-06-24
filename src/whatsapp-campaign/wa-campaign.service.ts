import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WaCampaign, WaCampaignDocument, WaUtmParam } from './schemas/wa-campaign.schema';
import { WaDelivery, WaDeliveryDocument } from './schemas/wa-delivery.schema';
import { WaTemplate, WaTemplateDocument, WaTemplateComponent } from './schemas/wa-template.schema';
import { WaService, MetaMessageComponent } from './wa.service';
import { GeoipService } from '../geoip/geoip.service';

const BATCH_SIZE = 20; // Meta Cloud API: cómodo bien por debajo del límite de 80/s

export interface WaCampaignAnalytics {
  totalClicks: number;
  uniqueClickers: number;
  byUtm: Record<
    string,
    Array<{ value: string; sent: number; clicks: number; uniqueClickers: number }>
  >;
}

export interface WaCountryReport {
  fieldId: string | null;
  fieldLabel: string | null;
  byCountry: Array<{ value: string; label: string | null; count: number }>;
  unknown: number;
  total: number;
}

export interface WaGeoAnalytics {
  byCountry: Array<{ country: string; clicks: number; uniqueClickers: number }>;
  unknown: { clicks: number; uniqueClickers: number };
}

@Injectable()
export class WaCampaignService {
  private readonly logger = new Logger(WaCampaignService.name);

  constructor(
    @InjectModel(WaCampaign.name)
    private readonly campaignModel: Model<WaCampaignDocument>,
    @InjectModel(WaDelivery.name)
    private readonly deliveryModel: Model<WaDeliveryDocument>,
    @InjectModel(WaTemplate.name)
    private readonly templateModel: Model<WaTemplateDocument>,
    @InjectModel('OrgAttendee')
    private readonly attendeeModel: Model<any>,
    @InjectModel('Event')
    private readonly eventModel: Model<any>,
    @InjectModel('Organization')
    private readonly orgModel: Model<any>,
    private readonly waService: WaService,
    private readonly geoipService: GeoipService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async findAll(orgId: string, eventId: string): Promise<WaCampaign[]> {
    return this.campaignModel
      .find({ orgId: new Types.ObjectId(orgId), eventId: new Types.ObjectId(eventId) })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findOne(id: string): Promise<WaCampaign> {
    const campaign = await this.campaignModel.findById(id).lean();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    return campaign;
  }

  async create(
    dto: {
      orgId: string;
      eventId: string;
      name: string;
      templateId: string;
      utmParams?: WaUtmParam[];
    },
    createdBy: string,
  ): Promise<WaCampaign> {
    const template = await this.templateModel.findById(dto.templateId).lean();
    if (!template) throw new NotFoundException('Template no encontrado');
    if (template.status !== 'approved') {
      throw new BadRequestException('El template debe estar aprobado por Meta antes de usarlo');
    }

    return this.campaignModel.create({
      orgId: new Types.ObjectId(dto.orgId),
      eventId: new Types.ObjectId(dto.eventId),
      name: dto.name,
      templateId: new Types.ObjectId(dto.templateId),
      utmParams: dto.utmParams ?? null,
      createdBy,
    });
  }

  async cancel(id: string): Promise<void> {
    await this.campaignModel.findByIdAndUpdate(id, {
      $set: { status: 'cancelled' },
    });
  }

  async delete(id: string): Promise<void> {
    const campaign = await this.campaignModel.findById(id).lean();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    if (campaign.status === 'sending') {
      throw new BadRequestException('No se puede eliminar una campaña mientras está enviando');
    }
    await Promise.all([
      this.campaignModel.findByIdAndDelete(id),
      this.deliveryModel.deleteMany({ campaignId: new Types.ObjectId(id) }),
    ]);
  }

  // ─── Envío ────────────────────────────────────────────────────────────────

  async send(campaignId: string): Promise<{ total: number }> {
    const campaign = await this.campaignModel.findById(campaignId);
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    if (campaign.status !== 'draft') {
      throw new BadRequestException(`No se puede enviar una campaña en estado "${campaign.status}"`);
    }

    const template = await this.templateModel.findById(campaign.templateId).lean();
    if (!template || template.status !== 'approved') {
      throw new BadRequestException('El template no está aprobado');
    }

    const [event, org] = await Promise.all([
      this.eventModel.findById(campaign.eventId).lean(),
      this.orgModel.findById(campaign.orgId).lean(),
    ]);
    if (!event || !org) throw new NotFoundException('Evento u organización no encontrado');

    const { telefonoFieldId, codigoPaisFieldId } = this.getOrgPhoneFieldIds(org);

    // Buscar attendees con teléfono — priorizar registrationData si la org tiene esos campos
    let rawAttendees: any[];
    if (telefonoFieldId) {
      rawAttendees = await this.attendeeModel
        .find({
          organizationId: campaign.orgId.toString(),
          [`registrationData.${telefonoFieldId}`]: { $exists: true, $nin: [null, ''] },
        })
        .lean();
    } else {
      rawAttendees = await this.attendeeModel
        .find({
          organizationId: campaign.orgId.toString(),
          phone: { $nin: [null, ''] },
          phoneStatus: 'valid',
        })
        .lean();
    }

    // Resolver teléfono por attendee y descartar los inválidos
    const deliveryDocs: any[] = [];
    for (const a of rawAttendees) {
      const phone = telefonoFieldId
        ? this.buildPhoneFromRegistrationData(a, telefonoFieldId, codigoPaisFieldId)
        : (a as any).phone;
      if (!phone || phone.replace(/\D/g, '').length < 7) continue;
      deliveryDocs.push({
        campaignId: campaign._id,
        orgId: campaign.orgId,
        eventId: campaign.eventId,
        attendeeId: (a as any)._id,
        phone,
        name: (a as any).name,
        status: 'pending',
      });
    }

    if (deliveryDocs.length === 0) {
      throw new BadRequestException('No hay asistentes con teléfono válido para enviar');
    }

    await this.deliveryModel.insertMany(deliveryDocs, { ordered: false });

    await campaign.updateOne({
      $set: {
        status: 'sending',
        startedAt: new Date(),
        templateSnapshot: {
          name: template.name,
          language: template.language,
          components: template.components,
          variableMappings: template.variableMappings,
        },
        'stats.total': deliveryDocs.length,
        'stats.pending': deliveryDocs.length,
      },
    });

    // Procesar en batches de forma async (no bloquea la respuesta HTTP)
    this.processBatches(campaign._id.toString(), template, event, org).catch((err) =>
      this.logger.error(`Error en batch de campaña ${campaignId}: ${err.message}`),
    );

    return { total: deliveryDocs.length };
  }

  private async processBatches(
    campaignId: string,
    template: WaTemplate,
    event: any,
    org: any,
  ): Promise<void> {
    const campaignObjId = new Types.ObjectId(campaignId);

    try {
      while (true) {
        const batch = await this.deliveryModel
          .find({ campaignId: campaignObjId, status: 'pending' })
          .limit(BATCH_SIZE)
          .lean();

        if (batch.length === 0) break;

        const campaign = await this.campaignModel.findById(campaignId).lean();
        if (!campaign || campaign.status === 'cancelled') break;

        await Promise.all(
          batch.map((delivery) =>
            this.processSingleDelivery(delivery, template, event, org, campaign.utmParams ?? []),
          ),
        );
      }

      // Marcar completada si no fue cancelada
      const current = await this.campaignModel.findById(campaignId).lean();
      if (current?.status === 'sending') {
        await this.campaignModel.findByIdAndUpdate(campaignId, {
          $set: { status: 'completed', completedAt: new Date() },
        });
      }
    } catch (err) {
      await this.campaignModel.findByIdAndUpdate(campaignId, {
        $set: { status: 'failed' },
      });
      throw err;
    }
  }

  private async processSingleDelivery(
    delivery: any,
    template: WaTemplate,
    event: any,
    org: any,
    utmParams: WaUtmParam[],
  ): Promise<void> {
    const attendee = await this.attendeeModel.findById(delivery.attendeeId).lean();
    if (!attendee) return;

    const resolvedUtms = this.buildResolvedUtms(utmParams, attendee, event);
    const resolved = this.resolveVariables(
      template.variableMappings,
      attendee,
      event,
      org,
      resolvedUtms,
      delivery._id.toString(),
    );

    const components = this.buildMessageComponents(template.components, resolved);

    try {
      const result = await this.waService.sendTemplate(
        delivery.phone,
        template.name,
        template.language,
        components,
      );

      await this.deliveryModel.findByIdAndUpdate(delivery._id, {
        $set: {
          status: 'sent',
          waMessageId: result.messageId,
          resolvedComponents: resolved,
          resolvedUtms,
          sentAt: new Date(),
        },
      });

      await this.campaignModel.findByIdAndUpdate(delivery.campaignId, {
        $inc: { 'stats.sent': 1, 'stats.pending': -1 },
      });
    } catch (err: any) {
      await this.deliveryModel.findByIdAndUpdate(delivery._id, {
        $set: {
          status: 'failed',
          errorMessage: err.message ?? 'Error desconocido',
        },
      });

      await this.campaignModel.findByIdAndUpdate(delivery.campaignId, {
        $inc: { 'stats.failed': 1, 'stats.pending': -1 },
      });
    }
  }

  // ─── Resolución de variables ──────────────────────────────────────────────

  private resolveVariables(
    mappings: Record<string, string>,
    attendee: any,
    event: any,
    org: any,
    resolvedUtms: Record<string, string>,
    deliveryId: string,
  ): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const [key, source] of Object.entries(mappings)) {
      resolved[key] = this.resolveSource(source, attendee, event, org, resolvedUtms, deliveryId);
    }

    return resolved;
  }

  private resolveSource(
    source: string,
    attendee: any,
    event: any,
    org: any,
    resolvedUtms: Record<string, string>,
    deliveryId: string,
  ): string {
    switch (source) {
      case 'attendee.name':
        return attendee.name ?? '';
      case 'event.title':
        return event.title ?? '';
      case 'event.startDate': {
        const date = event.schedule?.startsAt;
        // Meta rechaza templates con parámetros vacíos ("(#131008) Required
        // parameter is missing") para TODOS los destinatarios, así que un
        // evento sin fecha configurada no puede resolver a ''.
        if (!date) return 'Por confirmar';
        return new Intl.DateTimeFormat('es', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: 'America/Bogota',
        }).format(new Date(date));
      }
      case 'event.slug':
        return event.slug ?? '';
      case 'event.coverImageUrl':
        // Si el evento no tiene portada, usar el logo de la organización
        // para evitar que Meta rechace el envío por parámetro vacío.
        return event.branding?.coverImageUrl ?? org.branding?.logoUrl ?? '';
      case 'org.slug':
        return org.domainSlug ?? '';
      case '_tracking_url': {
        const token = Buffer.from(deliveryId).toString('base64url');
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(resolvedUtms)) {
          if (value) params.set(key, value);
        }
        params.set('_tc', token);
        return `org/${org.domainSlug ?? ''}/event/${event.slug ?? ''}/attend?${params.toString()}`;
      }
      default:
        // Soporte para campos custom del form: "form.telefono", "attendee.registrationData.campo"
        if (source.startsWith('form.')) {
          const field = source.slice(5);
          return attendee.registrationData?.[field] ?? '';
        }
        return '';
    }
  }

  private buildResolvedUtms(
    utmParams: WaUtmParam[],
    attendee: any,
    event: any,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const p of utmParams) {
      let value = p.value;
      if (value.startsWith('attendee.')) {
        const field = value.slice(9);
        value = attendee[field] ?? attendee.registrationData?.[field] ?? p.value;
      } else if (value.startsWith('event.')) {
        const field = value.slice(6);
        value = event[field] ?? p.value;
      } else if (value.startsWith('form.')) {
        const field = value.slice(5);
        value = attendee.registrationData?.[field] ?? p.value;
      }
      result[p.name] = value;
    }
    return result;
  }

  private buildMessageComponents(
    templateComponents: WaTemplateComponent[],
    resolved: Record<string, string>,
  ): MetaMessageComponent[] {
    const result: MetaMessageComponent[] = [];

    const headerComp = templateComponents.find((c) => c.type === 'HEADER');
    if (headerComp && resolved['header.1'] !== undefined) {
      if (headerComp.format === 'IMAGE') {
        result.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: resolved['header.1'] } }],
        });
      } else {
        result.push({
          type: 'header',
          parameters: [{ type: 'text', text: resolved['header.1'] }],
        });
      }
    }

    const bodyComp = templateComponents.find((c) => c.type === 'BODY');
    if (bodyComp) {
      const params: string[] = [];
      let i = 1;
      while (resolved[`body.${i}`] !== undefined) {
        params.push(resolved[`body.${i}`]);
        i++;
      }
      if (params.length > 0) {
        result.push({
          type: 'body',
          parameters: params.map((t) => ({ type: 'text', text: t })),
        });
      }
    }

    const buttonsComp = templateComponents.find((c) => c.type === 'BUTTONS');
    if (buttonsComp?.buttons) {
      buttonsComp.buttons.forEach((btn, idx) => {
        const paramKey = `button.${idx}.1`;
        if (btn.type === 'URL' && resolved[paramKey]) {
          result.push({
            type: 'button',
            sub_type: 'url',
            index: idx,
            parameters: [{ type: 'text', text: resolved[paramKey] }],
          });
        }
      });
    }

    return result;
  }

  // ─── Helpers: campos de teléfono por org ─────────────────────────────────

  private getOrgPhoneFieldIds(org: any): {
    telefonoFieldId: string | null;
    codigoPaisFieldId: string | null;
  } {
    const fields: any[] = org?.registrationForm?.fields ?? [];
    const telefonoField = fields.find(
      (f: any) => typeof f.id === 'string' && f.id.startsWith('telefono_'),
    );
    const codigoPaisField = fields.find(
      (f: any) => typeof f.id === 'string' && f.id.startsWith('codigo_pais_'),
    );
    return {
      telefonoFieldId: telefonoField?.id ?? null,
      codigoPaisFieldId: codigoPaisField?.id ?? null,
    };
  }

  /**
   * Construye el número de teléfono E.164 (sin '+') a partir de registrationData.
   * Combina codigo_pais_* (ej: "+57") con telefono_* (ej: "3001234567") → "573001234567".
   * Si el telefono ya incluye el código (empieza con '+' o con los dígitos del código), no lo duplica.
   */
  private buildPhoneFromRegistrationData(
    attendee: any,
    telefonoFieldId: string,
    codigoPaisFieldId: string | null,
  ): string | null {
    const rawTel = String(attendee.registrationData?.[telefonoFieldId] ?? '').trim();
    if (!rawTel) return null;

    // Ya viene en formato E.164 con '+': strip el + y devolver
    if (rawTel.startsWith('+')) {
      return rawTel.slice(1).replace(/\D/g, '') || null;
    }

    const rawCodigo = codigoPaisFieldId
      ? String(attendee.registrationData?.[codigoPaisFieldId] ?? '').trim()
      : '';
    const codigoDigits = rawCodigo.replace(/^\+/, '').replace(/\D/g, '');
    const telDigits = rawTel.replace(/\D/g, '');

    if (!telDigits) return null;

    // Evitar duplicar el código si ya está embebido en el telefono
    if (codigoDigits && telDigits.startsWith(codigoDigits) && telDigits.length > codigoDigits.length) {
      return telDigits;
    }

    return codigoDigits ? codigoDigits + telDigits : telDigits;
  }

  // ─── Preview destinatarios (antes de enviar) ─────────────────────────────

  async previewRecipients(
    campaignId: string,
    opts: { page?: number; limit?: number },
  ): Promise<{ data: { phone: string; name: string }[]; total: number }> {
    const campaign = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');

    const org = await this.orgModel.findById(campaign.orgId).lean();
    const { telefonoFieldId, codigoPaisFieldId } = this.getOrgPhoneFieldIds(org);

    const { page = 1, limit = 50 } = opts;

    let filter: any;
    if (telefonoFieldId) {
      filter = {
        organizationId: campaign.orgId.toString(),
        [`registrationData.${telefonoFieldId}`]: { $exists: true, $nin: [null, ''] },
      };
    } else {
      filter = {
        organizationId: campaign.orgId.toString(),
        phone: { $nin: [null, ''] },
        phoneStatus: 'valid',
      };
    }

    const [rawData, total] = await Promise.all([
      this.attendeeModel
        .find(filter)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<any[]>(),
      this.attendeeModel.countDocuments(filter),
    ]);

    const data = rawData.map((a) => ({
      phone: telefonoFieldId
        ? (this.buildPhoneFromRegistrationData(a, telefonoFieldId, codigoPaisFieldId) ?? '')
        : (a.phone ?? ''),
      name: a.name ?? '',
    }));

    return { data, total };
  }

  // ─── Deliveries ───────────────────────────────────────────────────────────

  async listDeliveries(
    campaignId: string,
    opts: { status?: string; page?: number; limit?: number },
  ): Promise<{ data: WaDelivery[]; total: number }> {
    const { status, page = 1, limit = 50 } = opts;
    const filter: any = { campaignId: new Types.ObjectId(campaignId) };
    if (status && status !== 'all') filter.status = status;

    const [data, total] = await Promise.all([
      this.deliveryModel
        .find(filter)
        .skip((page - 1) * limit)
        .limit(limit)
        .sort({ createdAt: 1 })
        .lean(),
      this.deliveryModel.countDocuments(filter),
    ]);

    return { data, total };
  }

  // ─── Analítica de clics por UTM ──────────────────────────────────────────

  async getCampaignAnalytics(campaignId: string): Promise<WaCampaignAnalytics> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }

    const campaignObjId = new Types.ObjectId(campaignId);

    const [totals] = await this.deliveryModel.aggregate([
      { $match: { campaignId: campaignObjId, clickCount: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: '$clickCount' },
          uniqueClickers: { $sum: 1 },
        },
      },
    ]);

    const totalClicks: number = totals?.totalClicks ?? 0;
    const uniqueClickers: number = totals?.uniqueClickers ?? 0;

    // Agrupa los clics por cada par (clave, valor) de resolvedUtms
    const utmAgg = await this.deliveryModel.aggregate([
      { $match: { campaignId: campaignObjId, clickCount: { $gt: 0 } } },
      { $project: { clickCount: 1, resolvedUtms: { $objectToArray: '$resolvedUtms' } } },
      { $unwind: '$resolvedUtms' },
      {
        $group: {
          _id: { utmKey: '$resolvedUtms.k', utmValue: '$resolvedUtms.v' },
          uniqueClickers: { $sum: 1 },
          clicks: { $sum: '$clickCount' },
        },
      },
      {
        $group: {
          _id: '$_id.utmKey',
          values: {
            $push: {
              value: '$_id.utmValue',
              clicks: '$clicks',
              uniqueClickers: '$uniqueClickers',
            },
          },
        },
      },
    ]);

    // Enviados por valor de UTM: agrega las entregas efectivamente enviadas
    // (sentAt != null) por su `resolvedUtms`. Permite la comparativa
    // "envío vs clic" por UTM, incluyendo valores sin clics todavía.
    const sentUtmAgg = await this.deliveryModel.aggregate([
      { $match: { campaignId: campaignObjId, sentAt: { $ne: null } } },
      { $project: { resolvedUtms: { $objectToArray: '$resolvedUtms' } } },
      { $unwind: '$resolvedUtms' },
      {
        $group: {
          _id: { utmKey: '$resolvedUtms.k', utmValue: '$resolvedUtms.v' },
          sent: { $sum: 1 },
        },
      },
    ]);

    const sentMap = new Map<string, Map<string, number>>();
    for (const row of sentUtmAgg) {
      const key = row._id.utmKey as string;
      const value = row._id.utmValue as string;
      if (!sentMap.has(key)) sentMap.set(key, new Map());
      sentMap.get(key)!.set(value, row.sent as number);
    }

    const utmKeys = new Set<string>([
      ...utmAgg.map((u) => u._id as string),
      ...sentMap.keys(),
    ]);

    const byUtm: WaCampaignAnalytics['byUtm'] = {};
    for (const utmKey of utmKeys) {
      const clickValues =
        (utmAgg.find((u) => u._id === utmKey)?.values as Array<{
          value: string;
          clicks: number;
          uniqueClickers: number;
        }>) ?? [];

      const merged = new Map<
        string,
        { value: string; sent: number; clicks: number; uniqueClickers: number }
      >();
      for (const [value, sent] of sentMap.get(utmKey) ?? []) {
        merged.set(value, { value, sent, clicks: 0, uniqueClickers: 0 });
      }
      for (const cv of clickValues) {
        const existing = merged.get(cv.value);
        if (existing) {
          existing.clicks = cv.clicks;
          existing.uniqueClickers = cv.uniqueClickers;
        } else {
          merged.set(cv.value, {
            value: cv.value,
            sent: 0,
            clicks: cv.clicks,
            uniqueClickers: cv.uniqueClickers,
          });
        }
      }

      byUtm[utmKey] = [...merged.values()].sort(
        (a, b) => b.sent - a.sent || b.uniqueClickers - a.uniqueClickers,
      );
    }

    return { totalClicks, uniqueClickers, byUtm };
  }

  // ─── País declarado en el formulario de registro ──────────────────────────

  /**
   * Detecta el campo "país" del formulario de la org. Prioriza un campo cuyo
   * `optionsSource` sea 'countries'; si no, uno cuyo id sugiera país.
   */
  private detectCountryField(org: any): any | null {
    const fields: any[] = org?.registrationForm?.fields ?? [];
    const bySource = fields.find((f) => f?.optionsSource === 'countries');
    if (bySource) return bySource;
    return (
      fields.find(
        (f) =>
          typeof f?.id === 'string' &&
          /^(pais|country)(_|$)/i.test(f.id) &&
          f.type === 'select',
      ) ?? null
    );
  }

  /**
   * Reporte de envíos agrupados por país DECLARADO en el formulario de registro.
   * Mismo criterio que email: usa las etiquetas del propio formulario cuando
   * existen. Si la org no tiene campo país, `fieldId` es null.
   */
  async getCountryReport(campaignId: string): Promise<WaCountryReport> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }
    const campaign = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException('Campaña no encontrada');

    const org = await this.orgModel.findById(campaign.orgId).lean();
    const field = this.detectCountryField(org);

    const campaignObjId = new Types.ObjectId(campaignId);
    const total = await this.deliveryModel.countDocuments({ campaignId: campaignObjId });

    if (!field) {
      return { fieldId: null, fieldLabel: null, byCountry: [], unknown: total, total };
    }

    const fieldId: string = field.id;
    const labelMap = new Map<string, string>();
    for (const opt of (field.options ?? []) as Array<{ value: string; label: string }>) {
      if (opt?.value != null) labelMap.set(String(opt.value), opt.label);
    }

    const agg = await this.deliveryModel.aggregate([
      { $match: { campaignId: campaignObjId } },
      {
        $lookup: {
          from: this.attendeeModel.collection.name,
          localField: 'attendeeId',
          foreignField: '_id',
          as: 'att',
        },
      },
      { $unwind: { path: '$att', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: [`$att.registrationData.${fieldId}`, null] },
          count: { $sum: 1 },
        },
      },
    ]);

    const byCountry: WaCountryReport['byCountry'] = [];
    let unknown = 0;
    for (const row of agg) {
      const value = row._id;
      if (value == null || value === '') {
        unknown += row.count;
      } else {
        const v = String(value);
        byCountry.push({ value: v, label: labelMap.get(v) ?? null, count: row.count });
      }
    }
    byCountry.sort((a, b) => b.count - a.count);

    return { fieldId, fieldLabel: field.label ?? fieldId, byCountry, unknown, total };
  }

  // ─── País por geolocalización de IP del clic ──────────────────────────────

  /**
   * Clics agrupados por país de origen (geolocalización de la IP del clic).
   * En WhatsApp cada delivery es un destinatario, así que el país vive en el
   * propio delivery (`geoCountry`). Los clics sin país resuelto van a `unknown`.
   */
  async getGeoAnalytics(campaignId: string): Promise<WaGeoAnalytics> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }
    const campaignObjId = new Types.ObjectId(campaignId);

    const agg = await this.deliveryModel.aggregate([
      { $match: { campaignId: campaignObjId, clickCount: { $gt: 0 } } },
      {
        $group: {
          _id: '$geoCountry',
          uniqueClickers: { $sum: 1 },
          clicks: { $sum: '$clickCount' },
        },
      },
    ]);

    const byCountry: WaGeoAnalytics['byCountry'] = [];
    const unknown = { clicks: 0, uniqueClickers: 0 };
    for (const row of agg) {
      const country = row._id as string | null;
      if (!country) {
        unknown.clicks += row.clicks;
        unknown.uniqueClickers += row.uniqueClickers;
      } else {
        byCountry.push({
          country,
          clicks: row.clicks,
          uniqueClickers: row.uniqueClickers,
        });
      }
    }
    byCountry.sort((a, b) => b.uniqueClickers - a.uniqueClickers);

    return { byCountry, unknown };
  }

  /**
   * Re-resuelve el país de los deliveries que ya tienen clic e IP pero aún no
   * tienen `geoCountry`. Útil tras activar la geolocalización. Devuelve cuántos
   * se actualizaron.
   */
  async backfillGeo(campaignId: string): Promise<{ updated: number; pending: number }> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }
    const campaignObjId = new Types.ObjectId(campaignId);

    const pending = await this.deliveryModel
      .find({
        campaignId: campaignObjId,
        geoCountry: null,
        clickIp: { $nin: [null, ''] },
      })
      .select('_id clickIp')
      .lean();

    let updated = 0;
    for (const d of pending) {
      const iso = this.geoipService.lookupCountry((d as any).clickIp)?.iso ?? null;
      if (iso) {
        await this.deliveryModel.updateOne(
          { _id: (d as any)._id },
          { $set: { geoCountry: iso } },
        );
        updated++;
      }
    }

    return { updated, pending: pending.length };
  }
}
