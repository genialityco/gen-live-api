/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { EventsService } from '../../events/events.service';

/**
 * Como EventOwnerGuard, pero para rutas que identifican el evento por
 * `eventSlug` (config del estudio, aprovisionamiento). Va después de
 * FirebaseAuthGuard.
 */
@Injectable()
export class EventSlugOwnerGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => EventsService))
    private events: EventsService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const eventSlug =
      req.params?.eventSlug || req.body?.eventSlug || req.query?.eventSlug;
    if (!eventSlug) throw new ForbiddenException('Missing eventSlug');

    const ok = await this.events.isOwnerOfEventSlug(
      String(eventSlug),
      String(req.user?.uid ?? ''),
    );
    if (!ok) throw new ForbiddenException('Not the owner');
    return true;
  }
}
