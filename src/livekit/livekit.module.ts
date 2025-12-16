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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LiveStreamConfig.name, schema: LiveStreamConfigSchema },
    ]),
  ],
  providers: [LivekitService, LivekitEgressService, LiveConfigService],
  controllers: [LivekitController, LiveController],
  exports: [LivekitService, LivekitEgressService, LiveConfigService],
})
export class LivekitModule {}
