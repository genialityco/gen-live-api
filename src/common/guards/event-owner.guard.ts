/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventsService } from '../../events/events.service';

@Injectable()
export class EventOwnerGuard implements CanActivate {
  constructor(private events: EventsService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const userUid = req.user?.uid;
    const eventId = req.params.eventId || req.body.eventId || req.query.eventId;
    if (!eventId) throw new ForbiddenException('Missing eventId');

    const ev = await this.events.findById(eventId);
    if (!ev) throw new ForbiddenException('Event not found');
    // asegúrate que el EventsService.findById() devuelva orgId y puedas pedir ownerUid:
    const orgOwnerUid = await this.events.getOwnerUidByEventId(eventId);
    if (orgOwnerUid !== userUid) throw new ForbiddenException('Not the owner');
    return true;
  }
}
