import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WaTemplate, WaTemplateSchema } from './schemas/wa-template.schema';
import { WaCampaign, WaCampaignSchema } from './schemas/wa-campaign.schema';
import { WaDelivery, WaDeliverySchema } from './schemas/wa-delivery.schema';
import { WaService } from './wa.service';
import { WaTemplateService } from './wa-template.service';
import { WaCampaignService } from './wa-campaign.service';
import { WaWebhookService } from './wa-webhook.service';
import { WaCampaignController } from './wa-campaign.controller';
import { WaWebhookController } from './wa-webhook.controller';
// Schemas externos que el service necesita para resolver variables
import { OrgAttendee, OrgAttendeeSchema } from '../organizations/schemas/org-attendee.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WaTemplate.name, schema: WaTemplateSchema },
      { name: WaCampaign.name, schema: WaCampaignSchema },
      { name: WaDelivery.name, schema: WaDeliverySchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [WaCampaignController, WaWebhookController],
  providers: [WaService, WaTemplateService, WaCampaignService, WaWebhookService],
  exports: [WaCampaignService, WaTemplateService],
})
export class WaCampaignModule {}
