import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  EmailClick,
  EmailClickDocument,
  detectBot,
} from './schemas/email-click.schema';
import {
  EmailDelivery,
  EmailDeliveryDocument,
} from './schemas/email-delivery.schema';
import { EmailCampaign } from './schemas/email-campaign.schema';

export interface CampaignAnalytics {
  totalClicks: number;
  uniqueClickers: number;
  byUtm: Record<string, Array<{ value: string; clicks: number }>>;
}

@Injectable()
export class EmailTrackService {
  private readonly logger = new Logger(EmailTrackService.name);
  private readonly apiUrl: string;

  constructor(
    @InjectModel(EmailClick.name)
    private readonly clickModel: Model<EmailClickDocument>,
    @InjectModel(EmailDelivery.name)
    private readonly deliveryModel: Model<EmailDeliveryDocument>,
    @InjectModel(EmailCampaign.name)
    private readonly campaignModel: Model<any>,
    private readonly configService: ConfigService,
  ) {
    this.apiUrl =
      this.configService.get<string>('API_URL') ||
      `http://localhost:${this.configService.get<string>('PORT') ?? '8080'}`;
  }

  buildTrackUrl(deliveryId: string | Types.ObjectId): string {
    const token = Buffer.from(deliveryId.toString()).toString('base64url');
    return `${this.apiUrl}/track/click/${token}`;
  }

  private decodeToken(token: string): string {
    return Buffer.from(token, 'base64url').toString('utf8');
  }

  /**
   * Registers a click, updates counters, and returns the redirect URL.
   * Returns null if the token is invalid.
   */
  async recordClick(
    token: string,
    ip: string,
    userAgent: string,
  ): Promise<string | null> {
    let deliveryId: string;
    try {
      deliveryId = this.decodeToken(token);
      if (!Types.ObjectId.isValid(deliveryId)) return null;
    } catch {
      return null;
    }

    const delivery = await this.deliveryModel.findById(deliveryId).lean();
    if (!delivery) return null;

    const isBot = detectBot(userAgent);
    const now = new Date();

    const utms = delivery.resolvedUtms as unknown as Record<string, string> ?? {};

    await this.clickModel.create({
      campaignId: delivery.campaignId,
      deliveryId: delivery._id,
      attendeeId: delivery.attendeeId,
      orgId: delivery.orgId,
      eventId: delivery.eventId,
      utms,
      userAgent: userAgent.slice(0, 500),
      ip,
      isBot,
      clickedAt: now,
      arrivedAt: null,
    });

    if (!isBot) {
      const isFirstClick = (delivery.clickCount ?? 0) === 0;
      const deliveryUpdate: Record<string, any> = {
        $inc: { clickCount: 1 },
      };
      if (isFirstClick) {
        deliveryUpdate.$set = { firstClickAt: now };
      }
      await this.deliveryModel.findByIdAndUpdate(deliveryId, deliveryUpdate);

      const campaignInc: Record<string, number> = { 'stats.totalClicks': 1 };
      if (isFirstClick) campaignInc['stats.clicked'] = 1;
      await this.campaignModel.findByIdAndUpdate(delivery.campaignId, {
        $inc: campaignInc,
      });
    }

    const originalUrl = (delivery as any).originalUrl as string | null;
    if (!originalUrl) return null;

    const separator = originalUrl.includes('?') ? '&' : '?';
    return `${originalUrl}${separator}_tc=${token}`;
  }

  async recordArrival(token: string): Promise<void> {
    let deliveryId: string;
    try {
      deliveryId = this.decodeToken(token);
      if (!Types.ObjectId.isValid(deliveryId)) return;
    } catch {
      return;
    }

    await this.clickModel.findOneAndUpdate(
      { deliveryId: new Types.ObjectId(deliveryId), arrivedAt: null },
      { $set: { arrivedAt: new Date() } },
      { sort: { clickedAt: -1 } },
    );
  }

  async getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }

    const campaignObjId = new Types.ObjectId(campaignId);

    const [totals] = await this.clickModel.aggregate([
      { $match: { campaignId: campaignObjId, isBot: false } },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: 1 },
          uniqueDeliveries: { $addToSet: '$deliveryId' },
        },
      },
      {
        $project: {
          totalClicks: 1,
          uniqueClickers: { $size: '$uniqueDeliveries' },
        },
      },
    ]);

    const totalClicks: number = totals?.totalClicks ?? 0;
    const uniqueClickers: number = totals?.uniqueClickers ?? 0;

    const clickDocs = await this.clickModel
      .find({ campaignId: campaignObjId, isBot: false })
      .select('utms')
      .lean();

    const utmMap: Record<string, Record<string, number>> = {};
    for (const doc of clickDocs) {
      const utms = doc.utms as unknown as Record<string, string>;
      if (!utms) continue;
      const entries =
        utms instanceof Map ? [...utms.entries()] : Object.entries(utms);
      for (const [key, val] of entries) {
        if (!key || !val) continue;
        if (!utmMap[key]) utmMap[key] = {};
        utmMap[key][val] = (utmMap[key][val] ?? 0) + 1;
      }
    }

    const byUtm: CampaignAnalytics['byUtm'] = {};
    for (const [utmKey, values] of Object.entries(utmMap)) {
      byUtm[utmKey] = Object.entries(values)
        .map(([value, clicks]) => ({ value, clicks }))
        .sort((a, b) => b.clicks - a.clicks);
    }

    return { totalClicks, uniqueClickers, byUtm };
  }
}
