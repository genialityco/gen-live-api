import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EmailCampaign,
  EmailCampaignSchema,
} from './schemas/email-campaign.schema';
import {
  EmailDelivery,
  EmailDeliverySchema,
} from './schemas/email-delivery.schema';
import {
  EventUser,
  EventUserSchema,
} from '../events/schemas/event-user.schema';
import {
  OrgAttendee,
  OrgAttendeeSchema,
} from '../organizations/schemas/org-attendee.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  EventEmailTemplate,
  EventEmailTemplateSchema,
} from '../event-email/schemas/event-email-template.schema';
import { EventEmailModule } from '../event-email/event-email.module';
import { EmailCampaignService } from './email-campaign.service';
import { EmailCampaignController } from './email-campaign.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailCampaign.name, schema: EmailCampaignSchema },
      { name: EmailDelivery.name, schema: EmailDeliverySchema },
      { name: EventUser.name, schema: EventUserSchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: EventEmailTemplate.name, schema: EventEmailTemplateSchema },
    ]),
    EventEmailModule,
  ],
  controllers: [EmailCampaignController],
  providers: [EmailCampaignService],
})
export class EmailCampaignModule {}
