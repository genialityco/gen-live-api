import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LiveStreamConfig,
  LiveStreamConfigDocument,
} from './schemas/live-stream-config.schema';

@Injectable()
export class LiveConfigService {
  constructor(
    @InjectModel(LiveStreamConfig.name)
    private readonly model: Model<LiveStreamConfigDocument>,
  ) {}

  async getOrCreate(eventSlug: string) {
    const cfg = await this.model.findOne({ eventSlug });
    if (cfg) return cfg;

    return this.model.create({
      eventSlug,
      ingestProtocol: 'rtmp',
      layout: 'grid',
      maxParticipants: 20,
    });
  }

  async update(eventSlug: string, patch: Partial<LiveStreamConfig>) {
    return this.model.findOneAndUpdate(
      { eventSlug },
      { $set: { ...patch, eventSlug } },
      { new: true, upsert: true },
    );
  }

  async get(eventSlug: string) {
    const cfg = await this.model.findOne({ eventSlug }).lean();
    if (!cfg) throw new NotFoundException('Live config no existe');
    return cfg;
  }
}
