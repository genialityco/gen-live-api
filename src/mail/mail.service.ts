// src/mail/mail.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface SendTemplateEmailOptions {
  to: string | string[];
  subject: string;
  templateName: string; // nombre del archivo .hbs
  context?: Record<string, any>;
  replyTo?: string | string[];
  fromName?: string;
}

export interface OrgAccessRecoveryEmailOptions {
  to: string;
  orgName: string;
  accessUrl?: string;
  identifierSummary: { label: string; value: string }[];
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly sesClient: SESClient;
  private readonly fromEmail: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
    );
    this.fromEmail = this.configService.get<string>('AWS_SES_EMAIL_FROM')!;

    this.sesClient = new SESClient({
      region,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
  }

  private renderTemplate(
    templateName: string,
    context: Record<string, any> = {},
  ): string {
    // src/mail/templates/<templateName>.hbs
    const filePath = join(__dirname, 'templates', `${templateName}.hbs`);
    const source = readFileSync(filePath, 'utf-8');
    const template = Handlebars.compile(source);
    return template(context);
  }

  async sendTemplateEmail(options: SendTemplateEmailOptions): Promise<void> {
    const {
      to,
      subject,
      templateName,
      context = {},
      replyTo,
      fromName,
    } = options;

    const toAddresses = Array.isArray(to) ? to : [to];
    const replyToAddresses = replyTo
      ? Array.isArray(replyTo)
        ? replyTo
        : [replyTo]
      : undefined;

    const htmlBody = this.renderTemplate(templateName, context);

    // 👉 Si llega fromName, armar formato: "Nombre <correo>"
    const source = fromName
      ? `${fromName} <${this.fromEmail}>`
      : this.fromEmail;

    const command = new SendEmailCommand({
      Destination: {
        ToAddresses: toAddresses,
      },
      Message: {
        Body: {
          Html: {
            Data: htmlBody,
            Charset: 'UTF-8',
          },
        },
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
      },
      Source: source,
      ReplyToAddresses: replyToAddresses,
    });

    try {
      const res = await this.sesClient.send(command);
      this.logger.log(`Email enviado via SES. MessageId=${res.MessageId}`);
    } catch (error) {
      this.logger.error('Error enviando email via SES', error);
      throw error;
    }
  }

  async sendOrgAccessRecoveryEmail(
    options: OrgAccessRecoveryEmailOptions,
  ): Promise<void> {
    const { to, orgName, accessUrl, identifierSummary } = options;

    const subject = `Recupera tu acceso a ${orgName}`;

    await this.sendTemplateEmail({
      to,
      subject,
      templateName: 'org-access-recovery',
      fromName: orgName,
      context: {
        orgName,
        accessUrl,
        identifierSummary,
      },
    });
  }
}
