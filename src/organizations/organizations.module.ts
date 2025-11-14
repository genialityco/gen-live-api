import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Organization,
  OrganizationSchema,
} from './schemas/organization.schema';
import { OrgAttendee, OrgAttendeeSchema } from './schemas/org-attendee.schema';
import { OrganizationsController } from './organizations.controller';
import { OrgAttendeeController } from './org-attendee.controller';
import { OrganizationsService } from './organizations.service';
import { OrgAttendeeService } from './org-attendee.service';
import { StorageService } from './storage.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema },
      { name: OrgAttendee.name, schema: OrgAttendeeSchema },
    ]),
  ],
  providers: [OrganizationsService, OrgAttendeeService, StorageService],
  controllers: [OrganizationsController, OrgAttendeeController],
  exports: [OrganizationsService, OrgAttendeeService, StorageService],
})
export class OrganizationsModule {}
