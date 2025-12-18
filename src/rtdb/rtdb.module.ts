import { Module } from '@nestjs/common';
import { RtdbService } from './rtdb.service';
import { RtdbPresenceWatcherService } from './rtdb-presence-watcher.service';
import * as admin from 'firebase-admin'; // Asegúrate de tener admin importado

@Module({
  providers: [
    RtdbService,
    RtdbPresenceWatcherService,
    {
      provide: 'RTDB',
      useFactory: () => admin.database(),
    },
  ],
  exports: [RtdbService, RtdbPresenceWatcherService, 'RTDB'],
})
export class RtdbModule {}
