/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Module, OnModuleInit, OnModuleDestroy, forwardRef } from '@nestjs/common';
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
import { Poll, PollSchema } from './schemas/poll.schema';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventUserService } from './event-user.service';
import { EventUserController } from './event-user.controller';
import { PollService } from './poll.service';
import { PollController } from './poll.controller';
import { ViewingMetricsService } from './viewing-metrics.service.v2';
import { RtdbModule } from '../rtdb/rtdb.module';
import { LivekitModule } from '../livekit/livekit.module';
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
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: EventUser.name, schema: EventUserSchema },
      { name: ViewingSession.name, schema: ViewingSessionSchema },
      { name: EventMetrics.name, schema: EventMetricsSchema },
      { name: Poll.name, schema: PollSchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
      { name: UserAccount.name, schema: UserAccountSchema },
    ]),
    RtdbModule,
    OrganizationsModule,
    forwardRef(() => LivekitModule),
  ],
  providers: [
    EventsService,
    EventUserService,
    ViewingMetricsService,
    PollService,
  ],
  controllers: [EventsController, EventUserController, PollController],
  exports: [
    EventsService,
    EventUserService,
    ViewingMetricsService,
    PollService,
  ],
})
export class EventsModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsModule.name);
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly metricsService: ViewingMetricsService) {}

  /**
   * Iniciar limpieza periódica de sesiones obsoletas
   * Ejecuta cada 30 minutos para evitar acumulación de memoria
   */
  onModuleInit() {
    // Limpieza inicial después de 5 minutos del inicio
    setTimeout(
      () => {
        this.metricsService
          .cleanupStaleSessions()
          .then((result) =>
            this.logger.log(
              `Initial cleanup: ${result.cleaned} stale sessions removed`,
            ),
          )
          .catch((err) =>
            this.logger.error(`Initial cleanup error: ${err.message}`),
          );
      },
      5 * 60 * 1000,
    );

    // Limpieza periódica cada 30 minutos
    this.cleanupInterval = setInterval(
      () => {
        this.metricsService
          .cleanupStaleSessions()
          .then((result) =>
            this.logger.log(
              `Periodic cleanup: ${result.cleaned} stale sessions removed`,
            ),
          )
          .catch((err) => this.logger.error(`Cleanup error: ${err.message}`));
      },
      30 * 60 * 1000,
    );

    this.logger.log(
      '✅ Periodic session cleanup scheduler initialized (every 30 min)',
    );
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.logger.log('🛑 Periodic session cleanup scheduler stopped');
    }
  }
}
