/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { CreateOrgAttendeeDto } from './dtos/create-org-attendee.dto';
import { UpdateBrandingDto } from './dtos/update-branding.dto';
import { UpdateRegistrationFormDto } from './dtos/update-registration-form.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import { StorageService } from './storage.service';

@Controller('orgs')
export class OrganizationsController {
  constructor(
    private svc: OrganizationsService,
    private storage: StorageService,
  ) {}

  @Post()
  @UseGuards(FirebaseAuthGuard) // solo cuentas normales (no anónimas)
  async create(@Body() dto: CreateOrganizationDto, @Req() req: any) {
    // ownerUid = admin autenticado
    return this.svc.create(req.user.uid, dto);
  }

  @Get('public')
  async getPublic() {
    // Endpoint público para listar todas las organizaciones
    return this.svc.listPublic();
  }

  @Get('slug/:slug')
  async getBySlug(@Param('slug') slug: string): Promise<any> {
    // Endpoint público para obtener una organización por slug
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');

    // Retornar solo información pública
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ownerUid, ...publicData } = org;
    return publicData;
  }

  @Get('slug/:slug/admin')
  @UseGuards(FirebaseAuthGuard)
  async getBySlugForAdmin(
    @Param('slug') slug: string,
    @Req() req: any,
  ): Promise<any> {
    // Endpoint protegido para obtener una organización completa (incluye ownerUid)
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');

    // Verificar que el usuario es el propietario
    if (org.ownerUid !== req.user?.uid) {
      throw new ForbiddenException('Not owner');
    }

    return org;
  }

  @Get('mine')
  @UseGuards(FirebaseAuthGuard) // solo cuentas normales (no anónimas)
  async mine(@Req() req: any) {
    return this.svc.listByOwnerUid(req.user.uid);
  }

  @Get(':orgId')
  @UseGuards(FirebaseAuthGuard) // solo cuentas normales (no anónimas)
  async getOne(@Param('orgId') orgId: string, @Req() req: any) {
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Org not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');
    return org;
  }

  @Patch('slug/:slug')
  @UseGuards(FirebaseAuthGuard)
  async updateOrganization(
    @Param('slug') slug: string,
    @Body() dto: UpdateOrganizationDto,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.updateOrganization(org._id.toString(), dto);
  }

  // =============== GESTIÓN DE ASISTENTES ===============

  @Post(':orgId/attendees')
  @UseGuards(FirebaseAuthGuard)
  async createAttendee(
    @Param('orgId') orgId: string,
    @Body() dto: CreateOrgAttendeeDto,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.createAttendee(orgId, dto);
  }

  @Get(':orgId/attendees')
  @UseGuards(FirebaseAuthGuard)
  async getAttendees(@Param('orgId') orgId: string, @Req() req: any) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.getAttendeesByOrg(orgId);
  }

  @Patch(':orgId/attendees/:attendeeId')
  @UseGuards(FirebaseAuthGuard)
  async updateAttendee(
    @Param('orgId') orgId: string,
    @Param('attendeeId') attendeeId: string,
    @Body() dto: any,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.updateOrgAttendee(attendeeId, dto);
  }

  @Get(':orgId/attendees/stats')
  @UseGuards(FirebaseAuthGuard)
  async getAttendeeStats(@Param('orgId') orgId: string, @Req() req: any) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.getAttendeeStats(orgId);
  }

  @Get(':orgId/events/:eventId/attendees')
  @UseGuards(FirebaseAuthGuard)
  async getEventAttendees(
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.getAttendeesByEvent(orgId, eventId);
  }

  @Get(':orgId/events/:eventId/attendees/stats')
  @UseGuards(FirebaseAuthGuard)
  async getEventAttendanceStats(
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.getEventAttendanceStats(orgId, eventId);
  }

  // =============== BRANDING ===============

  @Patch('slug/:slug/branding')
  @UseGuards(FirebaseAuthGuard)
  async updateBranding(
    @Param('slug') slug: string,
    @Body() dto: UpdateBrandingDto,
    @Req() req: any,
  ): Promise<any> {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.updateBranding(org._id.toString(), dto);
  }

  @Post('slug/:slug/upload/:folder')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadBrandingImage(
    @Param('slug') slug: string,
    @Param('folder') folder: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    if (!file) throw new BadRequestException('No file uploaded');

    // Validar folder permitidos
    const allowedFolders = [
      'logos',
      'covers',
      'favicons',
      'headers',
      'footers',
    ];
    if (!allowedFolders.includes(folder)) {
      throw new BadRequestException('Invalid folder');
    }

    // Validar tipo de archivo (solo imágenes)
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/svg+xml',
      'image/webp',
      'image/x-icon',
    ];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only images allowed.');
    }

    // Subir archivo
    const url = await this.storage.uploadFile(
      file.buffer,
      file.originalname,
      folder,
      org._id.toString(),
    );

    return { url };
  }

  // =============== FORMULARIO DE REGISTRO ===============

  @Patch('slug/:slug/registration-form')
  @UseGuards(FirebaseAuthGuard)
  async updateRegistrationForm(
    @Param('slug') slug: string,
    @Body() dto: UpdateRegistrationFormDto,
    @Req() req: any,
  ) {
    // Verificar que el usuario es propietario de la organización
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== req.user?.uid)
      throw new ForbiddenException('Not owner');

    return this.svc.updateRegistrationForm(org._id.toString(), dto);
  }

  @Get('slug/:slug/registration-form')
  async getRegistrationForm(@Param('slug') slug: string) {
    // Endpoint público para obtener el formulario de registro
    const org = await this.svc.findBySlug(slug);
    if (!org) throw new NotFoundException('Organization not found');

    return org.registrationForm || { enabled: false, fields: [] };
  }
}
