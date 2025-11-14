/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OrganizationsService } from '../../organizations/organizations.service';
import { Organization } from '../../organizations/schemas/organization.schema';

@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private orgs: OrganizationsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const orgId = req.params.orgId || req.body.orgId;

    if (!orgId) throw new ForbiddenException('Missing orgId');

    const org: Organization | null = await this.orgs.findById(orgId);

    if (!org) throw new ForbiddenException('Org not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return true;
  }
}
