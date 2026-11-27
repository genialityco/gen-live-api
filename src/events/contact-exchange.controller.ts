/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { ContactExchangeService } from './contact-exchange.service';
import {
  SaveContactCardDto,
  UpdateContactConsentDto,
} from './dtos/contact-exchange.dto';

/**
 * Intercambio de contactos entre colegas que se saludaron. Todo con la
 * sesión del asistente: el API resuelve quién es por su uid y solo entrega
 * datos de contacto a las dos personas de un par que ambas aceptaron.
 */
@Controller()
@UseGuards(FirebaseAuthGuard)
export class ContactExchangeController {
  constructor(private contacts: ContactExchangeService) {}

  @Get('events/:eventId/contacts/mine')
  mine(@Param('eventId') eventId: string, @Req() req: any) {
    return this.contacts.mine(eventId, String(req.user.uid));
  }

  @Put('events/:eventId/contacts/card')
  saveCard(
    @Param('eventId') eventId: string,
    @Body() dto: SaveContactCardDto,
    @Req() req: any,
  ) {
    return this.contacts.saveCard(eventId, String(req.user.uid), dto);
  }

  // Retira la autorización: deja de compartir con todos
  @Delete('events/:eventId/contacts/card')
  deleteCard(@Param('eventId') eventId: string, @Req() req: any) {
    return this.contacts.deleteCard(eventId, String(req.user.uid));
  }

  @Post('events/:eventId/contacts/:pairId/share')
  share(
    @Param('eventId') eventId: string,
    @Param('pairId') pairId: string,
    @Req() req: any,
  ) {
    return this.contacts.share(eventId, String(req.user.uid), pairId);
  }

  @Delete('events/:eventId/contacts/:pairId/share')
  unshare(
    @Param('eventId') eventId: string,
    @Param('pairId') pairId: string,
    @Req() req: any,
  ) {
    return this.contacts.unshare(eventId, String(req.user.uid), pairId);
  }

  @Post('events/:eventId/contacts/:pairId/dismiss')
  dismiss(
    @Param('eventId') eventId: string,
    @Param('pairId') pairId: string,
    @Req() req: any,
  ) {
    return this.contacts.dismiss(eventId, String(req.user.uid), pairId);
  }

  @Post('events/:eventId/contacts/:pairId/block')
  block(
    @Param('eventId') eventId: string,
    @Param('pairId') pairId: string,
    @Req() req: any,
  ) {
    return this.contacts.block(eventId, String(req.user.uid), pairId);
  }

  // Texto de autorización de la organización (solo el dueño)
  @Get('orgs/slug/:slug/contact-exchange')
  getOrgConsent(@Param('slug') slug: string, @Req() req: any) {
    return this.contacts.getOrgConsent(slug, String(req.user.uid));
  }

  @Put('orgs/slug/:slug/contact-exchange')
  updateOrgConsent(
    @Param('slug') slug: string,
    @Body() dto: UpdateContactConsentDto,
    @Req() req: any,
  ) {
    return this.contacts.updateOrgConsent(slug, String(req.user.uid), dto);
  }
}
