import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LivekitService } from './livekit.service';
import { LivekitController } from './livekit.controller';
import { LivekitEgressService } from './livekit-egress.service';
import { LiveController } from './livekit-egress.controller';
import { LiveConfigService } from './live-config.service';
import {
  LiveStreamConfig,
  LiveStreamConfigSchema,
} from './schemas/live-stream-config.schema';
import { RtdbModule } from 'src/rtdb/rtdb.module';
import { EventsModule } from 'src/events/events.module';
import { MuxService } from './mux.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LiveStreamConfig.name, schema: LiveStreamConfigSchema },
    ]),
    RtdbModule,
    EventsModule,
  ],
  providers: [
    LivekitService,
    LivekitEgressService,
    LiveConfigService,
    MuxService,
  ],
  controllers: [LivekitController, LiveController],
  exports: [
    LivekitService,
    LivekitEgressService,
    LiveConfigService,
    MuxService,
  ],
})
export class LivekitModule {}
