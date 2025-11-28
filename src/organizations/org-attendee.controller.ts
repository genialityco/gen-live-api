/* eslint-disable @typescript-eslint/no-unsafe-return */
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
import { BulkImportDto } from './dtos/bulk-import.dto';

@Controller('org-attendees')
export class OrgAttendeeController {
  constructor(private readonly orgAttendeeService: OrgAttendeeService) {}

  @Post('advanced-register')
  @HttpCode(HttpStatus.OK)
  async advancedRegister(
    @Body()
    body: {
      organizationId: string;
      attendeeId?: string;
      email: string;
      name?: string;
      phone?: string;
      formData: Record<string, any>;
      firebaseUID?: string;
      metadata?: Record<string, any>;
    },
  ) {
    return await this.orgAttendeeService.registerAdvanced(body.organizationId, {
      attendeeId: body.attendeeId,
      email: body.email,
      name: body.name,
      phone: body.phone,
      formData: body.formData,
      firebaseUID: body.firebaseUID,
      metadata: body.metadata,
    });
  }

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

  @Post('bulk-import')
  @HttpCode(HttpStatus.OK)
  async bulkImport(@Body() body: BulkImportDto) {
    return this.orgAttendeeService.bulkImport(body.organizationId, body.rows);
  }

  @Post('recover-access')
  @HttpCode(HttpStatus.OK)
  async recoverAccess(
    @Body()
    body: {
      organizationId: string;
      identifierFields: Record<string, any>;
      accessUrl?: string;
    },
  ) {
    return this.orgAttendeeService.sendRecoveryEmailByIdentifiers(
      body.organizationId,
      body.identifierFields,
      body.accessUrl,
    );
  }
}
