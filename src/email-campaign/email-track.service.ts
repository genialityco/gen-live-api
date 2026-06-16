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
import { GeoipService } from '../geoip/geoip.service';

export interface CampaignAnalytics {
  totalClicks: number;
  uniqueClickers: number;
  byUtm: Record<string, Array<{ value: string; clicks: number; uniqueClickers: number }>>;
}

export interface GeoAnalytics {
  byCountry: Array<{ country: string; clicks: number; uniqueClickers: number }>;
  unknown: { clicks: number; uniqueClickers: number };
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
    private readonly geoipService: GeoipService,
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
    const geoCountry = this.geoipService.lookupCountry(ip)?.iso ?? null;

    await this.clickModel.create({
      campaignId: delivery.campaignId,
      deliveryId: delivery._id,
      attendeeId: delivery.attendeeId,
      orgId: delivery.orgId,
      eventId: delivery.eventId,
      utms,
      userAgent: userAgent.slice(0, 500),
      ip,
      geoCountry,
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

    // Aggregation en MongoDB: calcula clics totales y clickers únicos por cada valor de UTM
    // Sin cargar todos los docs en memoria
    const utmAgg = await this.clickModel.aggregate([
      { $match: { campaignId: campaignObjId, isBot: false } },
      // Convierte el mapa de UTMs en array de { k, v } para poder desanidar
      { $project: { deliveryId: 1, utms: { $objectToArray: '$utms' } } },
      { $unwind: '$utms' },
      // Nivel 1: agrupa por (utmKey, utmValue, deliveryId) → cuántos clics hizo esta persona con este UTM
      {
        $group: {
          _id: { utmKey: '$utms.k', utmValue: '$utms.v', deliveryId: '$deliveryId' },
          clicksPerUser: { $sum: 1 },
        },
      },
      // Nivel 2: agrupa por (utmKey, utmValue) → totalClicks y clickers únicos
      {
        $group: {
          _id: { utmKey: '$_id.utmKey', utmValue: '$_id.utmValue' },
          uniqueClickers: { $sum: 1 },
          clicks: { $sum: '$clicksPerUser' },
        },
      },
      // Nivel 3: agrupa por utmKey juntando todos sus valores
      {
        $group: {
          _id: '$_id.utmKey',
          values: {
            $push: {
              value: '$_id.utmValue',
              clicks: '$clicks',
              uniqueClickers: '$uniqueClickers',
            },
          },
        },
      },
    ]);

    const byUtm: CampaignAnalytics['byUtm'] = {};
    for (const { _id: utmKey, values } of utmAgg) {
      byUtm[utmKey] = (values as Array<{ value: string; clicks: number; uniqueClickers: number }>)
        .sort((a, b) => b.uniqueClickers - a.uniqueClickers);
    }

    return { totalClicks, uniqueClickers, byUtm };
  }

  /**
   * Clics agrupados por país de origen (geolocalización de la IP del clic).
   * Excluye bots. Los clics sin país resuelto se agregan en `unknown`.
   */
  async getGeoAnalytics(campaignId: string): Promise<GeoAnalytics> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }
    const campaignObjId = new Types.ObjectId(campaignId);

    // Nivel 1: por (país, deliveryId) → clics de cada persona en cada país
    // Nivel 2: por país → totalClicks y clickers únicos
    const agg = await this.clickModel.aggregate([
      { $match: { campaignId: campaignObjId, isBot: false } },
      {
        $group: {
          _id: { country: '$geoCountry', deliveryId: '$deliveryId' },
          clicksPerUser: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.country',
          uniqueClickers: { $sum: 1 },
          clicks: { $sum: '$clicksPerUser' },
        },
      },
    ]);

    const byCountry: GeoAnalytics['byCountry'] = [];
    const unknown = { clicks: 0, uniqueClickers: 0 };
    for (const row of agg) {
      const country = row._id as string | null;
      if (!country) {
        unknown.clicks += row.clicks;
        unknown.uniqueClickers += row.uniqueClickers;
      } else {
        byCountry.push({
          country,
          clicks: row.clicks,
          uniqueClickers: row.uniqueClickers,
        });
      }
    }
    byCountry.sort((a, b) => b.uniqueClickers - a.uniqueClickers);

    return { byCountry, unknown };
  }

  /**
   * Re-resuelve el país de los clics que aún no lo tienen (geoCountry null) a
   * partir de la IP ya almacenada. Útil tras activar la geolocalización para
   * enriquecer clics históricos. Devuelve cuántos se actualizaron.
   */
  async backfillGeo(campaignId: string): Promise<{ updated: number; pending: number }> {
    if (!Types.ObjectId.isValid(campaignId)) {
      throw new NotFoundException('Campaña no encontrada');
    }
    const campaignObjId = new Types.ObjectId(campaignId);

    const pending = await this.clickModel
      .find({
        campaignId: campaignObjId,
        geoCountry: null,
        ip: { $nin: [null, ''] },
      })
      .select('_id ip')
      .lean();

    let updated = 0;
    for (const click of pending) {
      const iso = this.geoipService.lookupCountry((click as any).ip)?.iso ?? null;
      if (iso) {
        await this.clickModel.updateOne(
          { _id: (click as any)._id },
          { $set: { geoCountry: iso } },
        );
        updated++;
      }
    }

    return { updated, pending: pending.length };
  }
}
