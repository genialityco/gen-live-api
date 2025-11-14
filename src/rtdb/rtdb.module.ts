import { Module } from '@nestjs/common';
import { RtdbService } from './rtdb.service';
import { RtdbPresenceWatcherService } from './rtdb-presence-watcher.service';

@Module({
  providers: [RtdbService, RtdbPresenceWatcherService],
  exports: [RtdbService, RtdbPresenceWatcherService],
})
export class RtdbModule {}
