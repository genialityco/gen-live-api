import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { EventsService } from '../events/events.service';

@Controller('public')
export class PublicController {
  constructor(private events: EventsService) {}

  @Get('events/:slug')
  async resolveEvent(@Param('slug') slug: string) {
    const ev = await this.events.bySlug(slug);
    // Si el evento está en diferido, activar el watcher de presencia on-demand
    // para contabilizar el tiempo de visualización del replay (se auto-apaga
    // cuando no queda audiencia).
    this.events.ensureReplayPresenceWatch(String(ev._id), ev.status);
    // Expón solo lo necesario públicamente
    return {
      eventId: String(ev._id),
      slug: ev.slug,
      title: ev.title,
      schedule: ev.schedule ?? null,
      stream: {
        provider: ev.stream?.provider ?? null,
        url: ev.stream?.url ?? null,
      },
      status: ev.status,
      orgId: String(ev.orgId),
    };
  }

  // register/attend ya los tienes; si no, agrégalos aquí
}
