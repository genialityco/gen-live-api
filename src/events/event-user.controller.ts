/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { EventUserService } from './event-user.service';
import { CheckRegistrationDto } from '../users/dto/user-account.dto';

@Controller('event-users')
export class EventUserController {
  constructor(private readonly eventUserService: EventUserService) {}

  @Post('check-registration')
  @HttpCode(HttpStatus.OK)
  async checkRegistration(@Body() checkRegistrationDto: CheckRegistrationDto) {
    return await this.eventUserService.checkRegistration(
      checkRegistrationDto.firebaseUid,
      checkRegistrationDto.eventId,
    );
  }

  @Get('by-attendee/:attendeeId/event/:eventId')
  async findByAttendeeAndEvent(
    @Param('attendeeId') attendeeId: string,
    @Param('eventId') eventId: string,
  ) {
    return await this.eventUserService.findByAttendeeAndEvent(
      attendeeId,
      eventId,
    );
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async registerToEvent(
    @Body()
    body: {
      attendeeId: string;
      eventId: string;
      firebaseUID?: string;
    },
  ) {
    return await this.eventUserService.registerUserToEvent(
      body.attendeeId,
      body.eventId,
      body.firebaseUID,
    );
  }

  @Patch('associate-firebase-uid')
  async associateFirebaseUid(
    @Body()
    body: {
      attendeeId: string;
      eventId: string;
      firebaseUID: string;
    },
  ) {
    return await this.eventUserService.associateFirebaseUid(
      body.attendeeId,
      body.eventId,
      body.firebaseUID,
    );
  }

  @Patch('update-login')
  async updateLastLogin(@Body() body: { attendeeId: string; eventId: string }) {
    return await this.eventUserService.updateLastLogin(
      body.attendeeId,
      body.eventId,
    );
  }

  @Patch('mark-attended')
  async markAsAttended(@Body() body: { attendeeId: string; eventId: string }) {
    return await this.eventUserService.markAsAttended(
      body.attendeeId,
      body.eventId,
    );
  }

  @Get('event/:eventId')
  async getEventUsers(
    @Param('eventId') eventId: string,
    @Query('status') status?: string,
  ) {
    return await this.eventUserService.getEventUsers(eventId, status);
  }

  @Get('user/:userAccountId/events')
  async getUserEvents(@Param('userAccountId') userAccountId: string) {
    return await this.eventUserService.getUserEvents(userAccountId);
  }

  @Get('event/:eventId/live-attendees')
  async getLiveAttendees(@Param('eventId') eventId: string) {
    return await this.eventUserService.getLiveAttendees(eventId);
  }
}
