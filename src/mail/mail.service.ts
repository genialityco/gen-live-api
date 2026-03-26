// src/mail/mail.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
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

  /**
   * Sends an email with pre-rendered HTML body (no .hbs template file needed).
   */
  async sendRawHtmlEmail(options: {
    to: string | string[];
    subject: string;
    htmlBody: string;
    fromName?: string;
  }): Promise<{ messageId: string }> {
    const { to, subject, htmlBody, fromName } = options;

    const toAddresses = Array.isArray(to) ? to : [to];
    const source = fromName
      ? `${fromName} <${this.fromEmail}>`
      : this.fromEmail;

    const command = new SendEmailCommand({
      Destination: { ToAddresses: toAddresses },
      Message: {
        Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
        Subject: { Data: subject, Charset: 'UTF-8' },
      },
      Source: source,
    });

    const res = await this.sesClient.send(command);
    this.logger.log(`Email enviado via SES. MessageId=${res.MessageId}`);
    return { messageId: res.MessageId ?? '' };
  }

  /**
   * Sends an HTML email with an attached .ics calendar invite.
   * Uses SendRawEmailCommand (MIME multipart) to support attachments.
   */
  async sendRawEmailWithIcal(options: {
    to: string;
    subject: string;
    htmlBody: string;
    fromName?: string;
    icalContent: string;
    icalFilename?: string;
  }): Promise<{ messageId: string }> {
    const { to, subject, htmlBody, fromName, icalContent, icalFilename = 'invitacion.ics' } = options;

    const source = fromName
      ? `${fromName} <${this.fromEmail}>`
      : this.fromEmail;

    // RFC2047 encode subject to handle UTF-8 / special chars
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;

    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const wrapBase64 = (b64: string): string => {
      const lines: string[] = [];
      for (let i = 0; i < b64.length; i += 76) {
        lines.push(b64.slice(i, i + 76));
      }
      return lines.join('\r\n');
    };

    const htmlB64 = wrapBase64(Buffer.from(htmlBody).toString('base64'));
    const icalB64 = wrapBase64(Buffer.from(icalContent).toString('base64'));

    const raw = [
      `From: ${source}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlB64,
      '',
      `--${boundary}`,
      `Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="${icalFilename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${icalFilename}"`,
      '',
      icalB64,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    const command = new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(raw) },
    });

    const res = await this.sesClient.send(command);
    this.logger.log(`Email+iCal enviado via SES. MessageId=${res.MessageId ?? ''}`);
    return { messageId: res.MessageId ?? '' };
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
