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
  private readonly appId?: string;
  private readonly baseUrl = 'https://graph.facebook.com/v22.0';

  constructor(private readonly configService: ConfigService) {
    this.phoneNumberId = configService.getOrThrow<string>('WA_PHONE_NUMBER_ID');
    this.accessToken = configService.getOrThrow<string>('WA_ACCESS_TOKEN');
    this.wabaId = configService.getOrThrow<string>('WA_WABA_ID');
    this.appId = configService.get<string>('WA_APP_ID');
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
   * Edita los componentes de un template ya existente en Meta (p.ej. para
   * actualizar la URL base de un botón cuando cambia FRONTEND_URL).
   * Meta vuelve a poner el template en revisión tras un edit.
   */
  async updateTemplate(metaTemplateId: string, components: WaTemplateComponent[]): Promise<void> {
    const url = `${this.baseUrl}/${metaTemplateId}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ components }),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = data?.error?.message ?? `Meta API error ${res.status}`;
      throw new Error(msg);
    }
  }

  /**
   * Descarga una imagen desde una URL pública y la sube a Meta usando la
   * Resumable Upload API, devolviendo el handle (`h`) requerido en
   * `example.header_handle` al enviar un template con header IMAGE a revisión.
   */
  async uploadMediaFromUrl(imageUrl: string): Promise<string> {
    if (!this.appId) {
      throw new Error(
        'WA_APP_ID no está configurado: es necesario para subir la imagen de ejemplo del header a Meta',
      );
    }

    const fileRes = await fetch(imageUrl);
    if (!fileRes.ok) {
      throw new Error(`No se pudo descargar la imagen de ejemplo (${fileRes.status})`);
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType = fileRes.headers.get('content-type') ?? 'image/jpeg';

    const sessionUrl =
      `${this.baseUrl}/${this.appId}/uploads` +
      `?file_length=${buffer.length}&file_type=${encodeURIComponent(contentType)}&access_token=${this.accessToken}`;
    const sessionRes = await fetch(sessionUrl, { method: 'POST' });
    const sessionData = (await sessionRes.json()) as any;
    if (!sessionRes.ok) {
      const msg = sessionData?.error?.message ?? `Meta API error ${sessionRes.status} al iniciar la subida`;
      throw new Error(msg);
    }

    // formato "upload:XYZ..." (puede incluir un sufijo "?sig=..." que Meta
    // espera como query string real, por lo que NO debe codificarse con
    // encodeURIComponent — eso convertiría el "?" en "%3F" y Meta respondería
    // "Object with ID ... does not exist").
    const uploadSessionId: string = sessionData.id;
    const uploadRes = await fetch(`${this.baseUrl}/${uploadSessionId}`, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${this.accessToken}`,
        'Content-Type': contentType,
        file_offset: '0',
      },
      body: buffer,
    });
    const uploadData = (await uploadRes.json()) as any;
    if (!uploadRes.ok) {
      const msg = uploadData?.error?.message ?? `Meta API error ${uploadRes.status} al subir la imagen`;
      throw new Error(msg);
    }

    return uploadData.h as string;
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
