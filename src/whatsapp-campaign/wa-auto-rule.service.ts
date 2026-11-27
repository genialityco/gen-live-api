import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WaAutoRule, WaAutoRuleDocument } from './schemas/wa-auto-rule.schema';
import {
  WaCampaign,
  WaCampaignDocument,
  WaUtmParam,
} from './schemas/wa-campaign.schema';
import { WaTemplate, WaTemplateDocument } from './schemas/wa-template.schema';
import {
  MAX_AUTO_SEND_DELAY_MIN,
  WA_AUDIENCES,
  eventsNeedingRuleCampaign,
  type WaAudience,
} from './wa-audience';

export interface WaAutoRuleInput {
  name?: string;
  templateId?: string;
  audience?: WaAudience;
  delayMinutes?: number;
  utmParams?: WaUtmParam[] | null;
  appliesFrom?: string | Date;
  enabled?: boolean;
}

/**
 * Reglas de campañas automáticas por organización: evitan crear a mano la
 * misma campaña (p. ej. «invitar a ver la grabación a quien no asistió») en
 * cada evento.
 *
 * `materialize` crea en cada evento que aplique una campaña en `draft` con
 * `autoSend`; desde ahí el envío lo hace WaAutoSendService cuando el evento
 * pasa a diferido, igual que una campaña programada a mano. La campaña
 * aparece en el evento desde antes, así que se puede revisar o cancelar.
 */
@Injectable()
export class WaAutoRuleService {
  private readonly logger = new Logger(WaAutoRuleService.name);

  constructor(
    @InjectModel(WaAutoRule.name)
    private readonly ruleModel: Model<WaAutoRuleDocument>,
    @InjectModel(WaCampaign.name)
    private readonly campaignModel: Model<WaCampaignDocument>,
    @InjectModel(WaTemplate.name)
    private readonly templateModel: Model<WaTemplateDocument>,
    @InjectModel('Event')
    private readonly eventModel: Model<any>,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  findAll(orgId: string) {
    return this.ruleModel
      .find({ orgId: new Types.ObjectId(orgId) })
      .sort({ createdAt: -1 })
      .lean();
  }

  async create(orgId: string, input: WaAutoRuleInput, createdBy: string) {
    if (!input.name?.trim())
      throw new BadRequestException('El nombre es obligatorio');
    if (!input.templateId)
      throw new BadRequestException('Selecciona un template');
    const data = await this.validate(input);
    return this.ruleModel.create({
      orgId: new Types.ObjectId(orgId),
      name: input.name.trim(),
      templateId: new Types.ObjectId(input.templateId),
      audience: data.audience ?? 'event_no_show',
      delayMinutes: data.delayMinutes ?? 0,
      utmParams: input.utmParams ?? null,
      appliesFrom: data.appliesFrom ?? new Date(),
      enabled: input.enabled ?? true,
      createdBy,
    });
  }

  /**
   * Al cambiar la regla se borran sus campañas que aún no se envían; en la
   * siguiente revisión se vuelven a crear con la configuración nueva (o no se
   * crean, si la regla quedó desactivada).
   */
  async update(id: string, input: WaAutoRuleInput) {
    const rule = await this.ruleModel.findById(id);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    const data = await this.validate(input);
    if (input.name !== undefined) {
      if (!input.name.trim())
        throw new BadRequestException('El nombre es obligatorio');
      rule.name = input.name.trim();
    }
    if (input.templateId)
      rule.templateId = new Types.ObjectId(input.templateId);
    if (data.audience) rule.audience = data.audience;
    if (data.delayMinutes !== undefined) rule.delayMinutes = data.delayMinutes;
    if (input.utmParams !== undefined) rule.utmParams = input.utmParams;
    if (data.appliesFrom) rule.appliesFrom = data.appliesFrom;
    if (input.enabled !== undefined) rule.enabled = !!input.enabled;
    await rule.save();
    await this.removePendingCampaigns(rule._id);
    return rule.toObject();
  }

  async delete(id: string): Promise<void> {
    const rule = await this.ruleModel.findById(id).lean();
    if (!rule) throw new NotFoundException('Regla no encontrada');
    await this.removePendingCampaigns(rule._id);
    await this.ruleModel.deleteOne({ _id: rule._id });
  }

  /** Campañas de la regla que siguen programadas (sin enviar ni cancelar) */
  private removePendingCampaigns(ruleId: Types.ObjectId) {
    return this.campaignModel.deleteMany({
      autoRuleId: ruleId,
      status: 'draft',
      'autoSend.firedAt': null,
    });
  }

  private async validate(input: WaAutoRuleInput) {
    const out: {
      audience?: WaAudience;
      delayMinutes?: number;
      appliesFrom?: Date;
    } = {};
    if (input.audience !== undefined) {
      if (!WA_AUDIENCES.includes(input.audience)) {
        throw new BadRequestException(`Audiencia inválida: ${input.audience}`);
      }
      out.audience = input.audience;
    }
    if (input.delayMinutes !== undefined) {
      const delay = Number(input.delayMinutes);
      if (
        !Number.isInteger(delay) ||
        delay < 0 ||
        delay > MAX_AUTO_SEND_DELAY_MIN
      ) {
        throw new BadRequestException(
          `La espera debe ser un número entero de minutos entre 0 y ${MAX_AUTO_SEND_DELAY_MIN}`,
        );
      }
      out.delayMinutes = delay;
    }
    if (input.appliesFrom !== undefined) {
      const d = new Date(input.appliesFrom);
      if (Number.isNaN(d.getTime()))
        throw new BadRequestException('Fecha inválida');
      out.appliesFrom = d;
    }
    if (input.templateId) {
      if (!Types.ObjectId.isValid(input.templateId)) {
        throw new BadRequestException('Template inválido');
      }
      const template = await this.templateModel
        .findById(input.templateId)
        .lean();
      if (!template) throw new NotFoundException('Template no encontrado');
      if (template.status !== 'approved') {
        throw new BadRequestException(
          'El template debe estar aprobado por Meta antes de usarlo',
        );
      }
    }
    return out;
  }

  // ─── Creación de campañas en los eventos ──────────────────────────────────

  /** Crea las campañas que falten para todas las reglas activas */
  async materialize(): Promise<void> {
    const rules = await this.ruleModel.find({ enabled: true }).lean();
    for (const rule of rules) {
      try {
        await this.materializeRule(rule);
      } catch (err) {
        this.logger.error(
          `[auto-rule] "${rule.name}" (${String(rule._id)}): ${String(err)}`,
        );
      }
    }
  }

  private async materializeRule(rule: WaAutoRule & { _id: Types.ObjectId }) {
    const events = await this.eventModel
      .find(
        { orgId: rule.orgId, 'schedule.startsAt': { $gte: rule.appliesFrom } },
        { _id: 1, hidden: 1, schedule: 1 },
      )
      .lean<
        {
          _id: Types.ObjectId;
          hidden?: boolean;
          schedule?: { startsAt?: Date };
        }[]
      >();
    if (events.length === 0) return;

    const campaigns = await this.campaignModel
      .find(
        {
          eventId: { $in: events.map((e) => e._id) },
          $or: [{ autoRuleId: rule._id }, { templateId: rule.templateId }],
        },
        { eventId: 1, templateId: 1, autoRuleId: 1, status: 1 },
      )
      .lean();

    const missing = eventsNeedingRuleCampaign(rule, events, campaigns);
    if (missing.length === 0) return;

    const template = await this.templateModel
      .findById(rule.templateId, { status: 1 })
      .lean();
    if (!template || template.status !== 'approved') {
      this.logger.warn(
        `[auto-rule] "${rule.name}" (${String(rule._id)}): el template no está aprobado, no se crean campañas`,
      );
      return;
    }

    for (const eventId of missing) {
      try {
        await this.campaignModel.create({
          orgId: rule.orgId,
          eventId: new Types.ObjectId(eventId),
          name: rule.name,
          templateId: rule.templateId,
          utmParams: rule.utmParams ?? null,
          audience: rule.audience,
          autoSend: {
            trigger: 'on_replay',
            delayMinutes: rule.delayMinutes,
            dueAt: null,
            firedAt: null,
            lastError: null,
          },
          autoRuleId: rule._id,
          createdBy: rule.createdBy,
        });
        this.logger.log(
          `[auto-rule] "${rule.name}": campaña programada en el evento ${eventId}`,
        );
      } catch (err) {
        // Otra instancia la creó al mismo tiempo (índice único evento + regla)
        if ((err as { code?: number } | null)?.code === 11000) continue;
        throw err;
      }
    }
  }
}
