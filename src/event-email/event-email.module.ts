import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EventEmailTemplate,
  EventEmailTemplateSchema,
} from './schemas/event-email-template.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import {
  EventUser,
  EventUserSchema,
} from '../events/schemas/event-user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  OrgAttendee,
  OrgAttendeeSchema,
} from '../organizations/schemas/org-attendee.schema';
import { EventEmailTemplateService } from './event-email-template.service';
import { EmailVariableService } from './email-variable.service';
import { EmailSendService } from './email-send.service';
import { EventEmailController } from './event-email.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventEmailTemplate.name, schema: EventEmailTemplateSchema },
      { name: Event.name, schema: EventSchema },
      { name: EventUser.name, schema: EventUserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
    ]),
  ],
  providers: [
    EventEmailTemplateService,
    EmailVariableService,
    EmailSendService,
  ],
  controllers: [EventEmailController],
  exports: [EmailSendService],
})
export class EventEmailModule {}
