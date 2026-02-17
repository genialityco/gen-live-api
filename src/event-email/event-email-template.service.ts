import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EventEmailTemplate,
  EventEmailTemplateDocument,
  EmailTemplateType,
} from './schemas/event-email-template.schema';
import { UpsertEmailTemplateDto } from './dtos/upsert-email-template.dto';

@Injectable()
export class EventEmailTemplateService {
  constructor(
    @InjectModel(EventEmailTemplate.name)
    private readonly model: Model<EventEmailTemplateDocument>,
  ) {}

  /**
   * Resolves a template with inheritance: event-level first, then org-level fallback.
   */
  async resolveTemplate(
    orgId: string,
    eventId: string,
    type: EmailTemplateType,
  ): Promise<any | null> {
    // Try event-specific first
    const eventTemplate = await this.model
      .findOne({
        orgId: new Types.ObjectId(orgId),
        eventId: new Types.ObjectId(eventId),
        type,
        enabled: true,
      })
      .lean<EventEmailTemplate>();
    if (eventTemplate) return eventTemplate;

    // Fallback to org default
    return this.model
      .findOne({
        orgId: new Types.ObjectId(orgId),
        eventId: null,
        type,
        enabled: true,
      })
      .lean<EventEmailTemplate>();
  }

  /**
   * Lists templates for an event, including inherited org defaults.
   * Marks org-level templates as `isInherited: true` when no event override exists.
   */
  async listForEvent(orgId: string, eventId: string): Promise<any[]> {
    const orgObjectId = new Types.ObjectId(orgId);
    const eventObjectId = new Types.ObjectId(eventId);

    // Get event-specific templates
    const eventTemplates = await this.model
      .find({ orgId: orgObjectId, eventId: eventObjectId })
      .lean();

    // Get org defaults
    const orgTemplates = await this.model
      .find({ orgId: orgObjectId, eventId: null })
      .lean();

    const result: any[] = [...eventTemplates];

    // Add org templates that don't have event overrides
    for (const orgTpl of orgTemplates) {
      const hasOverride = eventTemplates.some((et) => et.type === orgTpl.type);
      if (!hasOverride) {
        result.push({ ...orgTpl, isInherited: true });
      }
    }

    return result;
  }

  /**
   * Creates or updates a template by { orgId, eventId, type }.
   */
  async upsert(dto: UpsertEmailTemplateDto): Promise<any> {
    const filter = {
      orgId: new Types.ObjectId(dto.orgId),
      eventId: dto.eventId ? new Types.ObjectId(dto.eventId) : null,
      type: dto.type,
    };

    const update = {
      ...filter,
      name: dto.name,
      subject: dto.subject,
      body: dto.body,
      enabled: dto.enabled ?? true,
    };

    return this.model
      .findOneAndUpdate(filter, update, { upsert: true, new: true })
      .lean();
  }

  /**
   * Finds a template by its ID.
   */
  async findById(templateId: string): Promise<any | null> {
    return this.model.findById(templateId).lean();
  }

  /**
   * Deletes a template by ID.
   */
  async delete(templateId: string): Promise<void> {
    await this.model.findByIdAndDelete(templateId);
  }
}
