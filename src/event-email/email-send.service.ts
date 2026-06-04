/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MailService } from '../mail/mail.service';
import { EventEmailTemplateService } from './event-email-template.service';
import { EmailVariableService } from './email-variable.service';
import { Event, EventDocument } from '../events/schemas/event.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';

@Injectable()
export class EmailSendService {
  private readonly logger = new Logger(EmailSendService.name);
  private wrapperTemplate: HandlebarsTemplateDelegate | null = null;

  constructor(
    private readonly mailService: MailService,
    private readonly templateService: EventEmailTemplateService,
    private readonly variableService: EmailVariableService,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    @InjectModel(Organization.name)
    private readonly orgModel: Model<OrganizationDocument>,
    private readonly configService: ConfigService,
  ) {}

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

  /**
   * Sends the WELCOME email for a newly registered attendee.
   * Throws if SES fails — caller is responsible for catching.
   */
  async sendWelcomeEmail(params: {
    orgId: string;
    eventId: string;
    attendeeId: string;
    eventUserId: string;
    email: string;
    origin?: string;
  }): Promise<void> {
    const { orgId, eventId, attendeeId, eventUserId, email, origin } = params;

    // Resolve template with inheritance
    const template = await this.templateService.resolveTemplate(
      orgId,
      eventId,
      'WELCOME',
    );

    // No template or disabled → silent return
    if (!template) return;

    // Build context with real attendee data
    const context = await this.variableService.buildContext(
      orgId,
      eventId,
      attendeeId,
      eventUserId,
      origin,
    );

    // Compile subject and body
    const renderedSubject = Handlebars.compile(template.subject)(context);
    const renderedBody = Handlebars.compile(template.body)(context);

    // Wrap body with email wrapper
    const wrappedHtml = this.getWrapperTemplate()({
      ...context,
      content: renderedBody,
    });

    // Load org for fromName
    const org = await this.orgModel
      .findById(new Types.ObjectId(orgId))
      .lean<Organization>();

    // Send via SES — let errors propagate
    await this.mailService.sendRawHtmlEmail({
      to: email,
      subject: renderedSubject,
      htmlBody: wrappedHtml,
      fromName: org?.name,
    });

    this.logger.log(`Welcome email sent to ${email} for event ${eventId}`);
  }

  /**
   * Renders a template preview with sample or real data.
   */
  async renderPreview(params: {
    orgId: string;
    eventId?: string;
    subject: string;
    body: string;
    sampleAttendeeId?: string;
  }): Promise<{ renderedSubject: string; renderedBody: string }> {
    const { orgId, eventId, subject, body, sampleAttendeeId } = params;

    let context: Record<string, any>;

    if (sampleAttendeeId && eventId) {
      context = await this.variableService.buildContext(
        orgId,
        eventId,
        sampleAttendeeId,
      );
    } else {
      context = await this.variableService.buildSampleContext(orgId, eventId);
    }

    const renderedSubject = Handlebars.compile(subject)(context);
    const renderedBody = Handlebars.compile(body)(context);

    // Wrap with email wrapper for full preview
    const wrappedHtml = this.getWrapperTemplate()({
      ...context,
      content: renderedBody,
    });

    return { renderedSubject, renderedBody: wrappedHtml };
  }

  private buildIcal(
    event: EventDocument,
    orgSlug: string,
    orgName: string,
    frontendUrl: string,
  ): string | null {
    if (!event.schedule?.startsAt) return null;

    const formatDate = (d: Date): string =>
      d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

    const startsAt = new Date(event.schedule.startsAt);
    const endsAt = event.schedule.endsAt
      ? new Date(event.schedule.endsAt)
      : new Date(startsAt.getTime() + 60 * 60 * 1000);

    const uid = `test-${(event._id as Types.ObjectId).toString()}@geniality.io`;
    const attendUrl = `${frontendUrl}/org/${orgSlug}/event/${event.slug}/attend`;
    const summary = orgName ? `${orgName}: ${event.title}` : event.title;

    const descriptionParts: string[] = [];
    if (event.description) descriptionParts.push(event.description);
    descriptionParts.push(`Accede al evento: ${attendUrl}`);

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Gen.iality//Live Events//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatDate(new Date())}`,
      `DTSTART:${formatDate(startsAt)}`,
      `DTEND:${formatDate(endsAt)}`,
      `SUMMARY:${this.escapeIcal(summary)}`,
      `URL:${attendUrl}`,
      `LOCATION:${attendUrl}`,
      `DESCRIPTION:${this.escapeIcal(descriptionParts.join('\n\n'))}`,
    ];

    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map((l) => this.foldIcalLine(l)).join('\r\n');
  }

  /** RFC 5545 §3.1: fold lines > 75 octets with CRLF + SPACE. */
  private foldIcalLine(line: string): string {
    const buf = Buffer.from(line, 'utf8');
    if (buf.length <= 75) return line;

    const parts: string[] = [];
    let offset = 0;
    let first = true;

    while (offset < buf.length) {
      const limit = first ? 75 : 74;
      let end = Math.min(offset + limit, buf.length);
      while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
      parts.push((first ? '' : ' ') + buf.slice(offset, end).toString('utf8'));
      offset = end;
      first = false;
    }

    return parts.join('\r\n');
  }

  private escapeIcal(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  /**
   * Sends a test email to a specific address.
   * Accepts either a saved templateId OR raw subject+body.
   */
  async sendTestEmail(params: {
    orgId: string;
    eventId?: string;
    templateId?: string;
    subject?: string;
    body?: string;
    to: string;
    sampleAttendeeId?: string;
  }): Promise<void> {
    const { orgId, eventId, templateId, to, sampleAttendeeId } = params;

    let subjectTpl: string;
    let bodyTpl: string;

    // Prefer raw subject+body (from editor) over templateId
    if (params.subject && params.body) {
      subjectTpl = params.subject;
      bodyTpl = params.body;
    } else if (templateId) {
      const template = await this.templateService.findById(templateId);
      if (!template) {
        throw new Error('Template not found');
      }
      subjectTpl = template.subject;
      bodyTpl = template.body;
    } else {
      throw new Error('Either subject+body or templateId must be provided');
    }

    let context: Record<string, any>;

    if (sampleAttendeeId && eventId) {
      context = await this.variableService.buildContext(
        orgId,
        eventId,
        sampleAttendeeId,
      );
    } else {
      context = await this.variableService.buildSampleContext(orgId, eventId);
    }

    const renderedSubject = Handlebars.compile(subjectTpl)(context);
    const renderedBody = Handlebars.compile(bodyTpl)(context);

    const wrappedHtml = this.getWrapperTemplate()({
      ...context,
      content: renderedBody,
    });

    const org = await this.orgModel
      .findById(new Types.ObjectId(orgId))
      .lean<Organization>();

    // Adjuntar iCal si el evento tiene schedule
    let icalContent: string | null = null;
    if (eventId) {
      const event = await this.eventModel
        .findById(new Types.ObjectId(eventId))
        .lean<EventDocument>();
      if (event) {
        const frontendUrl =
          this.configService.get<string>('FRONTEND_URL') ?? '';
        icalContent = this.buildIcal(event, org?.domainSlug ?? '', org?.name ?? '', frontendUrl);
      }
    }

    const testSubject = `[TEST] ${renderedSubject}`;

    if (icalContent) {
      await this.mailService.sendRawEmailWithIcal({
        to,
        subject: testSubject,
        htmlBody: wrappedHtml,
        fromName: org?.name,
        icalContent,
      });
    } else {
      await this.mailService.sendRawHtmlEmail({
        to,
        subject: testSubject,
        htmlBody: wrappedHtml,
        fromName: org?.name,
      });
    }

    this.logger.log(`Test email sent to ${to}`);
  }
}
