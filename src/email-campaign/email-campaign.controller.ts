import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { EmailCampaignService } from './email-campaign.service';
import { CreateCampaignDto } from './dtos/create-campaign.dto';
import { ListDeliveriesDto } from './dtos/list-deliveries.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('email-campaign')
export class EmailCampaignController {
  constructor(private readonly campaignService: EmailCampaignService) {}

  @Post()
  async createCampaign(@Body() dto: CreateCampaignDto, @Req() req: any) {
    const createdBy: string = req.user.uid;
    return this.campaignService.createCampaign(dto, createdBy);
  }

  @Get('org/:orgId/event/:eventId')
  async listCampaigns(
    @Param('orgId') orgId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.campaignService.listCampaigns(orgId, eventId);
  }

  @Get(':campaignId')
  async getCampaign(@Param('campaignId') campaignId: string) {
    return this.campaignService.getCampaign(campaignId);
  }

  @Post(':campaignId/send')
  async sendCampaign(@Param('campaignId') campaignId: string) {
    return this.campaignService.sendCampaign(campaignId);
  }

  @Post(':campaignId/cancel')
  async cancelCampaign(@Param('campaignId') campaignId: string) {
    await this.campaignService.cancelCampaign(campaignId);
    return { ok: true };
  }

  @Post(':campaignId/resume')
  async resumeCampaign(@Param('campaignId') campaignId: string) {
    return this.campaignService.resumeCampaign(campaignId);
  }

  @Get(':campaignId/deliveries')
  async listDeliveries(
    @Param('campaignId') campaignId: string,
    @Query() dto: ListDeliveriesDto,
  ) {
    return this.campaignService.listDeliveries(campaignId, dto);
  }

  @Get(':campaignId/deliveries/export')
  async exportDeliveries(
    @Param('campaignId') campaignId: string,
    @Res() res: Response,
  ) {
    const csv = await this.campaignService.exportDeliveriesCsv(campaignId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campaign-${campaignId}.csv"`,
    );
    res.send('\uFEFF' + csv); // BOM para Excel
  }
}
