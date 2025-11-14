import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { OrgAttendeeService } from './org-attendee.service';

@Controller('org-attendees')
export class OrgAttendeeController {
  constructor(private readonly orgAttendeeService: OrgAttendeeService) {}

  @Get('by-email/:email/org/:organizationId')
  async findByEmailAndOrg(
    @Param('email') email: string,
    @Param('organizationId') organizationId: string,
  ) {
    return await this.orgAttendeeService.findByEmailAndOrg(
      email,
      organizationId,
    );
  }

  @Post('find-by-identifiers')
  @HttpCode(HttpStatus.OK)
  async findByIdentifiers(
    @Body()
    body: {
      organizationId: string;
      identifierFields: Record<string, any>;
    },
  ) {
    return await this.orgAttendeeService.findByIdentifiers(
      body.organizationId,
      body.identifierFields,
    );
  }

  @Post('create-or-update')
  @HttpCode(HttpStatus.CREATED)
  async createOrUpdate(
    @Body()
    body: {
      organizationId: string;
      name: string;
      email: string;
      phone?: string;
    },
  ) {
    return await this.orgAttendeeService.createOrUpdate(body.organizationId, {
      name: body.name,
      email: body.email,
      phone: body.phone,
    });
  }

  @Get('organization/:organizationId')
  async findByOrganization(@Param('organizationId') organizationId: string) {
    return await this.orgAttendeeService.findByOrganization(organizationId);
  }

  @Get('search/:organizationId')
  async search(
    @Param('organizationId') organizationId: string,
    @Query('query') query?: string,
  ) {
    return await this.orgAttendeeService.search(organizationId, query);
  }

  @Get('stats/:organizationId')
  async getOrganizationStats(@Param('organizationId') organizationId: string) {
    return await this.orgAttendeeService.getOrganizationStats(organizationId);
  }
}
