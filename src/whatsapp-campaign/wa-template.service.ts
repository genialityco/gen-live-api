import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  WaTemplate,
  WaTemplateDocument,
  WaTemplateComponent,
} from './schemas/wa-template.schema';
import { WaService } from './wa.service';

const DEFAULT_TEMPLATE_NAME = 'gen_event_invitation';

@Injectable()
export class WaTemplateService implements OnModuleInit {
  private readonly logger = new Logger(WaTemplateService.name);

  constructor(
    @InjectModel(WaTemplate.name)
    private readonly templateModel: Model<WaTemplateDocument>,
    private readonly waService: WaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.seedDefaultTemplate();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async findAll(): Promise<WaTemplate[]> {
    return this.templateModel.find().sort({ createdAt: -1 }).lean();
  }

  async findOne(id: string): Promise<WaTemplate> {
    const template = await this.templateModel.findById(id).lean();
    if (!template) throw new NotFoundException('Template no encontrado');
    return template;
  }

  async findApproved(): Promise<WaTemplate[]> {
    return this.templateModel.find({ status: 'approved' }).lean();
  }

  async create(
    dto: {
      name: string;
      displayName: string;
      category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
      language: string;
      components: WaTemplateComponent[];
      variableMappings: Record<string, string>;
    },
    createdBy: string,
  ): Promise<WaTemplate> {
    const template = new this.templateModel({ ...dto, createdBy, status: 'draft' });
    return template.save();
  }

  // ─── Submit a Meta para revisión ─────────────────────────────────────────

  async submitForReview(id: string): Promise<WaTemplate> {
    const template = await this.templateModel.findById(id);
    if (!template) throw new NotFoundException('Template no encontrado');

    const result = await this.waService.submitTemplate({
      name: template.name,
      category: template.category,
      language: template.language,
      components: template.components,
    });

    template.metaTemplateId = result.metaTemplateId;
    template.status = result.status === 'APPROVED' ? 'approved' : 'pending_review';
    await template.save();

    return template.toObject();
  }

  /**
   * Actualiza la URL base de los botones de tipo URL para que apunten al
   * FRONTEND_URL configurado actualmente, tanto en Meta como en Mongo.
   * Útil cuando el template se aprobó usando una URL de desarrollo
   * (p.ej. http://localhost:5174) y debe apuntar al dominio público real.
   */
  async syncTemplateUrl(id: string): Promise<WaTemplate> {
    const template = await this.templateModel.findById(id);
    if (!template) throw new NotFoundException('Template no encontrado');
    if (!template.metaTemplateId) {
      throw new NotFoundException('Template sin ID de Meta (aún no enviado a revisión)');
    }

    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL no está configurado');
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(frontendUrl)) {
      throw new Error(
        `FRONTEND_URL apunta a un dominio local (${frontendUrl}); Meta solo acepta URLs públicas en templates`,
      );
    }

    const updatedComponents = template.components.map((comp) => {
      if (comp.type !== 'BUTTONS' || !comp.buttons) return comp;
      return {
        ...comp,
        buttons: comp.buttons.map((btn) => {
          if (btn.type !== 'URL' || !btn.url) return btn;
          return { ...btn, url: btn.url.replace(/^https?:\/\/[^/]+/, frontendUrl) };
        }),
      };
    });

    await this.waService.updateTemplate(template.metaTemplateId, updatedComponents);

    template.components = updatedComponents;
    const status = await this.waService.getTemplateStatus(template.metaTemplateId);
    template.status = this.normalizeMetaStatus(status);
    await template.save();

    return template.toObject();
  }

  /** Sincroniza el status con Meta (para polling manual o webhook) */
  async syncStatus(id: string): Promise<WaTemplate> {
    const template = await this.templateModel.findById(id);
    if (!template || !template.metaTemplateId) {
      throw new NotFoundException('Template no encontrado o sin ID de Meta');
    }

    const status = await this.waService.getTemplateStatus(template.metaTemplateId);
    const normalized = this.normalizeMetaStatus(status);

    template.status = normalized;
    await template.save();

    return template.toObject();
  }

  /** Llamado por el webhook de Meta cuando cambia el status de un template */
  async handleStatusUpdate(metaTemplateId: string, status: string, reason?: string): Promise<void> {
    const normalized = this.normalizeMetaStatus(status);
    await this.templateModel.findOneAndUpdate(
      { metaTemplateId },
      {
        $set: {
          status: normalized,
          ...(reason ? { rejectionReason: reason } : {}),
        },
      },
    );
  }

  // ─── Default template ─────────────────────────────────────────────────────

  private async seedDefaultTemplate(): Promise<void> {
    const exists = await this.templateModel.findOne({ name: DEFAULT_TEMPLATE_NAME });
    if (exists) return;

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'https://your-domain.com';

    const components: WaTemplateComponent[] = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, te invitamos a participar en *{{2}}* 🎓\n\nFecha: {{3}}\n\n¡Haz clic para unirte al evento!',
        example: { body_text: [['Juan', 'Webinar Ejemplo', '15 Jun 2026 10:00']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Ver evento',
            url: `${frontendUrl}/{{1}}`,
            example: ['org/example/event/example/attend'],
          },
        ],
      },
    ];

    const variableMappings: Record<string, string> = {
      'body.1': 'attendee.name',
      'body.2': 'event.title',
      'body.3': 'event.startDate',
      'button.0.1': '_tracking_url',
    };

    await this.templateModel.create({
      name: DEFAULT_TEMPLATE_NAME,
      displayName: 'Invitación a Evento (Predeterminado)',
      category: 'MARKETING',
      language: 'es',
      components,
      variableMappings,
      status: 'draft',
      isDefault: true,
      createdBy: 'system',
    });

    this.logger.log('Template por defecto creado: gen_event_invitation');
  }

  private normalizeMetaStatus(metaStatus: string): WaTemplate['status'] {
    const map: Record<string, WaTemplate['status']> = {
      APPROVED: 'approved',
      PENDING: 'pending_review',
      REJECTED: 'rejected',
      PAUSED: 'paused',
      DISABLED: 'disabled',
      IN_APPEAL: 'pending_review',
    };
    return map[metaStatus?.toUpperCase()] ?? 'pending_review';
  }
}
