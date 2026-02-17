import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MailService } from '../mail/mail.service';
import { EventEmailTemplateService } from './event-email-template.service';
import { EmailVariableService } from './email-variable.service';
import {
  EventEmailTemplate,
  EventEmailTemplateDocument,
} from './schemas/event-email-template.schema';
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

    this.logger.log(
      `Welcome email sent to ${email} for event ${eventId}`,
    );
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

    await this.mailService.sendRawHtmlEmail({
      to,
      subject: `[TEST] ${renderedSubject}`,
      htmlBody: wrappedHtml,
      fromName: org?.name,
    });

    this.logger.log(`Test email sent to ${to}`);
  }
}
