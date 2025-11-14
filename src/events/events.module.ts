import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Event, EventSchema } from './schemas/event.schema';
import { EventUser, EventUserSchema } from './schemas/event-user.schema';
import {
  ViewingSession,
  ViewingSessionSchema,
} from './schemas/viewing-session.schema';
import {
  EventMetrics,
  EventMetricsSchema,
} from './schemas/event-metrics.schema';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventUserService } from './event-user.service';
import { EventUserController } from './event-user.controller';
import { ViewingMetricsService } from './viewing-metrics.service.v2';
import { RtdbModule } from '../rtdb/rtdb.module';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  OrgAttendee,
  OrgAttendeeSchema,
} from '../organizations/schemas/org-attendee.schema';
import {
  UserAccount,
  UserAccountSchema,
} from '../users/schemas/user-account.schema';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: EventUser.name, schema: EventUserSchema },
      { name: ViewingSession.name, schema: ViewingSessionSchema },
      { name: EventMetrics.name, schema: EventMetricsSchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
      { name: UserAccount.name, schema: UserAccountSchema },
    ]),
    RtdbModule,
    OrganizationsModule,
  ],
  providers: [EventsService, EventUserService, ViewingMetricsService],
  controllers: [EventsController, EventUserController],
  exports: [EventsService, EventUserService, ViewingMetricsService],
})
export class EventsModule {}
