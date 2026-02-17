import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { EventEmailTemplateService } from './event-email-template.service';
import { EmailVariableService } from './email-variable.service';
import { EmailSendService } from './email-send.service';
import { UpsertEmailTemplateDto } from './dtos/upsert-email-template.dto';
import { SendTestEmailDto } from './dtos/send-test-email.dto';

@Controller('event-email')
@UseGuards(FirebaseAuthGuard)
export class EventEmailController {
  constructor(
    private readonly templateService: EventEmailTemplateService,
    private readonly variableService: EmailVariableService,
    private readonly sendService: EmailSendService,
  ) {}

  /**
   * List templates for an event (including inherited org defaults).
   */
  @Get('org/:orgId/event/:eventId/templates')
  async listEventTemplates(
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.templateService.listForEvent(orgId, eventId);
  }

  /**
   * Create or update a template (upsert by orgId + eventId + type).
   */
  @Put('templates')
  async upsertTemplate(@Body() dto: UpsertEmailTemplateDto) {
    return this.templateService.upsert(dto);
  }

  /**
   * Delete a template by ID.
   */
  @Delete('templates/:templateId')
  async deleteTemplate(@Param('templateId') templateId: string) {
    await this.templateService.delete(templateId);
    return { ok: true };
  }

  /**
   * Get available variables for the template editor.
   */
  @Get('org/:orgId/variables')
  async getAvailableVariables(
    @Param('orgId') orgId: string,
    @Query('eventId') eventId?: string,
  ) {
    return this.variableService.getAvailableVariables(orgId, eventId);
  }

  /**
   * Preview a template with sample or real data.
   * Returns only wrapper+content, no scripts.
   */
  @Post('preview')
  async previewTemplate(
    @Body()
    body: {
      orgId: string;
      eventId?: string;
      subject: string;
      body: string;
      sampleAttendeeId?: string;
    },
  ) {
    return this.sendService.renderPreview({
      orgId: body.orgId,
      eventId: body.eventId,
      subject: body.subject,
      body: body.body,
      sampleAttendeeId: body.sampleAttendeeId,
    });
  }

  /**
   * Send a test email to a specific address.
   */
  @Post('org/:orgId/event/:eventId/send-test')
  async sendTestEmail(
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Body() dto: SendTestEmailDto,
  ) {
    await this.sendService.sendTestEmail({
      orgId,
      eventId,
      templateId: dto.templateId,
      subject: dto.subject,
      body: dto.body,
      to: dto.to,
      sampleAttendeeId: dto.sampleAttendeeId,
    });
    return { ok: true };
  }
}
