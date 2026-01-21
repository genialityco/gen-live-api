import { Module, forwardRef } from '@nestjs/common';
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
import { MediaItem, MediaItemSchema } from './schemas/media-item.schema';
import { MediaLibraryService } from './media-library.service';
import { MediaLibraryController } from './media-library.controller';
import { RtdbModule } from 'src/rtdb/rtdb.module';
import { EventsModule } from 'src/events/events.module';
import { MuxService } from './mux.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LiveStreamConfig.name, schema: LiveStreamConfigSchema },
      { name: MediaItem.name, schema: MediaItemSchema },
    ]),
    RtdbModule,
    forwardRef(() => EventsModule),
  ],
  providers: [
    LivekitService,
    LivekitEgressService,
    LiveConfigService,
    MuxService,
    MediaLibraryService,
  ],
  controllers: [LivekitController, LiveController, MediaLibraryController],
  exports: [
    LivekitService,
    LivekitEgressService,
    LiveConfigService,
    MuxService,
    MediaLibraryService,
  ],
})
export class LivekitModule {}
