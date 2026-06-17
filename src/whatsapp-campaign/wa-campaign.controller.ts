import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { WaCampaignService } from './wa-campaign.service';
import { WaTemplateService } from './wa-template.service';
import { WaUtmParam } from './schemas/wa-campaign.schema';
import { WaTemplateComponent } from './schemas/wa-template.schema';

@Controller('wa-campaign')
@UseGuards(FirebaseAuthGuard)
export class WaCampaignController {
  constructor(
    private readonly campaignService: WaCampaignService,
    private readonly templateService: WaTemplateService,
  ) {}

  // ─── Templates ────────────────────────────────────────────────────────────

  @Get('templates')
  listTemplates() {
    return this.templateService.findAll();
  }

  @Get('templates/approved')
  listApprovedTemplates() {
    return this.templateService.findApproved();
  }

  @Post('templates')
  createTemplate(
    @Body()
    body: {
      name: string;
      displayName: string;
      category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
      language: string;
      components: WaTemplateComponent[];
      variableMappings: Record<string, string>;
    },
    @Request() req: any,
  ) {
    return this.templateService.create(body, req.user.uid);
  }

  @Patch('templates/:id')
  updateTemplate(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      displayName: string;
      category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
      language: string;
      components: WaTemplateComponent[];
      variableMappings: Record<string, string>;
    },
  ) {
    return this.templateService.update(id, body);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  deleteTemplate(@Param('id') id: string) {
    return this.templateService.remove(id);
  }

  @Post('templates/:id/submit')
  @HttpCode(200)
  submitTemplate(@Param('id') id: string) {
    return this.templateService.submitForReview(id);
  }

  @Post('templates/:id/sync')
  @HttpCode(200)
  syncTemplate(@Param('id') id: string) {
    return this.templateService.syncStatus(id);
  }

  @Post('templates/:id/sync-url')
  @HttpCode(200)
  syncTemplateUrl(@Param('id') id: string) {
    return this.templateService.syncTemplateUrl(id);
  }

  // ─── Campaigns ────────────────────────────────────────────────────────────

  @Get()
  listCampaigns(
    @Query('orgId') orgId: string,
    @Query('eventId') eventId: string,
  ) {
    return this.campaignService.findAll(orgId, eventId);
  }

  @Get(':id/preview-recipients')
  previewRecipients(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.campaignService.previewRecipients(id, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 50,
    });
  }

  @Get(':id')
  getCampaign(@Param('id') id: string) {
    return this.campaignService.findOne(id);
  }

  @Post()
  createCampaign(
    @Body()
    body: {
      orgId: string;
      eventId: string;
      name: string;
      templateId: string;
      utmParams?: WaUtmParam[];
    },
    @Request() req: any,
  ) {
    return this.campaignService.create(body, req.user.uid);
  }

  @Post(':id/send')
  @HttpCode(200)
  sendCampaign(@Param('id') id: string) {
    return this.campaignService.send(id);
  }

  @Patch(':id/cancel')
  cancelCampaign(@Param('id') id: string) {
    return this.campaignService.cancel(id);
  }

  @Delete(':id')
  @HttpCode(204)
  deleteCampaign(@Param('id') id: string) {
    return this.campaignService.delete(id);
  }

  @Get(':id/deliveries')
  listDeliveries(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.campaignService.listDeliveries(id, {
      status,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 50,
    });
  }

  @Get(':id/analytics')
  getAnalytics(@Param('id') id: string) {
    return this.campaignService.getCampaignAnalytics(id);
  }

  // Reporte de envíos por país DECLARADO en el formulario de registro
  @Get(':id/country-report')
  getCountryReport(@Param('id') id: string) {
    return this.campaignService.getCountryReport(id);
  }

  // Clics por país de ORIGEN (geolocalización de IP)
  @Get(':id/geo-analytics')
  getGeoAnalytics(@Param('id') id: string) {
    return this.campaignService.getGeoAnalytics(id);
  }

  // Re-resuelve el país de clics históricos sin geo (tras activar la geolocalización)
  @Post(':id/backfill-geo')
  @HttpCode(200)
  backfillGeo(@Param('id') id: string) {
    return this.campaignService.backfillGeo(id);
  }
}
