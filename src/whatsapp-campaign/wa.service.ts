import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WaTemplateComponent } from './schemas/wa-template.schema';

export interface MetaMessageComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'url' | 'quick_reply';
  index?: number;
  parameters: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: { link: string } }
  >;
}

export interface SendTemplateResult {
  messageId: string;
}

export interface SubmitTemplateResult {
  metaTemplateId: string;
  status: string;
}

@Injectable()
export class WaService {
  private readonly logger = new Logger(WaService.name);
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly wabaId: string;
  private readonly baseUrl = 'https://graph.facebook.com/v20.0';

  constructor(private readonly configService: ConfigService) {
    this.phoneNumberId = configService.getOrThrow<string>('WA_PHONE_NUMBER_ID');
    this.accessToken = configService.getOrThrow<string>('WA_ACCESS_TOKEN');
    this.wabaId = configService.getOrThrow<string>('WA_WABA_ID');
  }

  /**
   * Envía un mensaje de template a un número de teléfono.
   * @param to  Número en formato internacional sin +, ej: 521234567890
   */
  async sendTemplate(
    to: string,
    templateName: string,
    language: string,
    components: MetaMessageComponent[],
  ): Promise<SendTemplateResult> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: components.length > 0 ? components : undefined,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = data?.error?.message ?? `Meta API error ${res.status}`;
      throw new Error(msg);
    }

    return { messageId: data.messages[0].id as string };
  }

  /**
   * Envía un template a revisión en Meta.
   * El template debe tener name único en el WABA.
   */
  async submitTemplate(template: {
    name: string;
    category: string;
    language: string;
    components: WaTemplateComponent[];
  }): Promise<SubmitTemplateResult> {
    const url = `${this.baseUrl}/${this.wabaId}/message_templates`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(template),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = data?.error?.message ?? `Meta API error ${res.status}`;
      throw new Error(msg);
    }

    return { metaTemplateId: data.id as string, status: data.status as string };
  }

  /**
   * Consulta el estado actual de un template en Meta.
   */
  async getTemplateStatus(metaTemplateId: string): Promise<string> {
    const url = `${this.baseUrl}/${metaTemplateId}?fields=status,rejected_reason`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    const data = (await res.json()) as any;
    return data.status as string;
  }
}
