/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  Req,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EventsService } from './events.service';
import { ViewingMetricsService } from './viewing-metrics.service.v2';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { OwnerGuard } from '../common/guards/owner.guard';
import { EventOwnerGuard } from '../common/guards/event-owner.guard';
import { CreateEventDto } from './dtos/create-event.dto';
import { UpdateEventDto } from './dtos/update-event.dto';
import { UpdateStatusDto } from './dtos/update-status.dto';
import { UpdateStreamDto } from './dtos/update-stream.dto';
import { UpdateEventBrandingDto } from './dtos/update-event-branding.dto';
import { RegisterToEventDto } from './dtos/register-to-event.dto';
import { FindRegistrationDto } from './dtos/find-registration.dto';
import { UpdateRegistrationDto } from './dtos/update-registration.dto';
import { StorageService } from '../organizations/storage.service';

@Controller('events')
export class EventsController {
  constructor(
    private svc: EventsService,
    private storage: StorageService,
    private metricsService: ViewingMetricsService,
  ) {}

  // ENDPOINTS PÚBLICOS (sin autenticación)

  // Lista eventos de una org (versión pública)
  @Get('public/by-org/:orgId')
  async byOrgPublic(@Param('orgId') orgId: string) {
    return await this.svc.listByOrgIdPublic(orgId);
  }

  // Registra un usuario a un evento (público - sin auth)
  @Post(':eventId/register')
  async registerToEvent(
    @Param('eventId') eventId: string,
    @Body() dto: RegisterToEventDto,
  ) {
    return this.svc.registerUserToEvent(eventId, dto);
  }

  // Verifica si un usuario ya está registrado en un evento (público)
  @Get(':eventId/is-registered')
  async isRegistered(
    @Param('eventId') eventId: string,
    @Query('email') email: string,
  ) {
    return await this.svc.isUserRegisteredToEvent(eventId, email);
  }

  // Verifica registro en una organización por campos identificadores (público)
  @Post('org/:orgId/check-registration-by-identifiers')
  async checkOrgRegistrationByIdentifiers(
    @Param('orgId') orgId: string,
    @Body() body: { identifierFields: Record<string, any> },
  ) {
    return await this.svc.checkOrgRegistrationByIdentifiers(
      orgId,
      body.identifierFields,
    );
  }

  // Verifica registro y devuelve datos del attendee usando campos identificadores
  @Post(':eventId/check-registration-by-identifiers')
  async checkRegistrationByIdentifiers(
    @Param('eventId') eventId: string,
    @Body() body: { identifierFields: Record<string, any> },
  ) {
    return await this.svc.checkRegistrationByIdentifiers(
      eventId,
      body.identifierFields,
    );
  }

  // Verifica si un usuario está registrado por Firebase UID (público)
  @Get(':eventId/is-registered-by-uid')
  async isRegisteredByUID(
    @Param('eventId') eventId: string,
    @Query('firebaseUID') firebaseUID: string,
  ) {
    const isRegistered = await this.svc.isUserRegisteredByUID(
      eventId,
      firebaseUID,
    );
    return { isRegistered };
  }

  // Asocia Firebase UID con un EventUser existente (público)
  @Post(':eventId/associate-firebase-uid')
  async associateFirebaseUID(
    @Param('eventId') eventId: string,
    @Body() body: { email: string; firebaseUID: string },
  ) {
    return await this.svc.associateFirebaseUID(
      eventId,
      body.email,
      body.firebaseUID,
    );
  }

  // Registra o actualiza un usuario con Firebase UID (público)
  @Post(':eventId/register-with-firebase')
  async registerWithFirebase(
    @Param('eventId') eventId: string,
    @Body() dto: RegisterToEventDto,
  ) {
    if (!dto.firebaseUID) {
      throw new BadRequestException(
        'Firebase UID is required for this endpoint',
      );
    }
    return this.svc.registerUserToEvent(eventId, dto);
  }

  // Crea EventUser para attendee existente (público)
  @Post(':eventId/create-event-user/:attendeeId')
  async createEventUser(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
  ) {
    return this.svc.createEventUserForExistingAttendee(eventId, attendeeId);
  }

  // Busca un registro existente por campos identificadores (público)
  @Post('find-registration')
  async findRegistration(@Body() dto: FindRegistrationDto) {
    const result = await this.svc.findRegistrationByIdentifiers(
      dto.eventId,
      dto.identifiers,
    );

    if (!result) {
      return { found: false };
    }

    return {
      found: true,
      attendee: result.attendee,
      eventUser: result.eventUser,
      isRegistered: result.isRegistered,
    };
  }

  // Actualiza un registro existente (público)
  @Patch('update-registration')
  async updateRegistration(@Body() dto: UpdateRegistrationDto) {
    const attendee = await this.svc.updateRegistration(
      dto.attendeeId,
      dto.formData,
      dto.metadata,
    );
    return { attendee };
  }

  // ENDPOINTS PRIVADOS (requieren autenticación)

  // Crea evento (requiere ser owner de la org)
  @Post()
  @UseGuards(FirebaseAuthGuard, OwnerGuard)
  async create(@Body() dto: CreateEventDto) {
    return this.svc.createForOrg(dto);
  }

  // Lista eventos del owner autenticado
  @Get('mine')
  @UseGuards(FirebaseAuthGuard)
  async mine(@Req() req: any) {
    return this.svc.listByOwnerUid(req.user.uid);
  }

  // Lista eventos de una org (sólo dueño de la org)
  @Get('by-org/:orgId')
  @UseGuards(FirebaseAuthGuard, OwnerGuard)
  async byOrg(@Param('orgId') orgId: string) {
    return this.svc.listByOrgId(orgId);
  }

  // Lee un evento (validación por dueñ@ del evento)
  @Get(':eventId')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async getOne(@Param('eventId') eventId: string) {
    return this.svc.findById(eventId);
  }

  // Actualiza información básica del evento (dueñ@ del evento)
  @Patch(':eventId')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async updateEvent(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.svc.updateEvent(eventId, dto);
  }

  // Cambia status (dueñ@ del evento)
  @Patch(':eventId/status')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async setStatus(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.svc.setStatus(eventId, dto.status);
  }

  @Patch(':eventId/stream')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async setStream(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateStreamDto,
  ) {
    return this.svc.updateStream(eventId, dto);
  }

  // Actualiza branding del evento (dueñ@ del evento)
  @Patch(':eventId/branding')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async updateBranding(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateEventBrandingDto,
  ) {
    return await this.svc.updateBranding(eventId, dto);
  }

  // Sube imágenes para branding del evento (dueñ@ del evento)
  @Post(':eventId/upload/:folder')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadEventImage(
    @Param('eventId') eventId: string,
    @Param('folder') folder: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    // Validar folder permitidos para eventos
    const allowedFolders = ['headers', 'covers', 'footers'];
    if (!allowedFolders.includes(folder)) {
      throw new BadRequestException(
        'Invalid folder. Allowed: headers, covers, footers',
      );
    }

    // Validar tipo de archivo (solo imágenes)
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/svg+xml',
      'image/webp',
    ];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only images allowed.');
    }

    // Subir archivo a Firebase Storage
    const url = await this.storage.uploadFile(
      file.buffer,
      file.originalname,
      folder,
      `events/${eventId}`, // Usar eventos como organizador de carpetas
    );

    return { url };
  }

  // ENDPOINTS DE MÉTRICAS (requieren ser dueño del evento)

  // Obtener métricas del evento (se crean automáticamente si no existen)
  @Get(':eventId/metrics')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async getMetrics(@Param('eventId') eventId: string) {
    return await this.metricsService.getEventMetrics(eventId);
  }

  // Recalcular métricas del evento (cuenta usuarios únicos que estuvieron durante live)
  @Post(':eventId/metrics/recalculate')
  @UseGuards(FirebaseAuthGuard, EventOwnerGuard)
  async recalculateMetrics(@Param('eventId') eventId: string) {
    return await this.metricsService.calculateEventMetrics(eventId);
  }
}
