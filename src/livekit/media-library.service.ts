/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MediaItem, MediaItemDocument } from './schemas/media-item.schema';
import {
  LiveStreamConfig,
  LiveStreamConfigDocument,
} from './schemas/live-stream-config.schema';
import * as admin from 'firebase-admin';

export interface CreateMediaItemDto {
  eventSlug: string;
  name: string;
  description?: string;
  tags?: string[];
  defaultMode?: 'overlay' | 'full';
  defaultLoop?: boolean;
  defaultMuted?: boolean;
  defaultFit?: 'cover' | 'contain';
  defaultOpacity?: number;
}

export interface UpdateMediaItemDto {
  name?: string;
  description?: string;
  tags?: string[];
  defaultMode?: 'overlay' | 'full';
  defaultLoop?: boolean;
  defaultMuted?: boolean;
  defaultFit?: 'cover' | 'contain';
  defaultOpacity?: number;
}

export interface MediaOverrides {
  mode?: 'overlay' | 'full';
  loop?: boolean;
  muted?: boolean;
  fit?: 'cover' | 'contain';
  opacity?: number;
}

export interface RequestUploadDto {
  eventSlug: string;
  name: string;
  mimeType: string;
  fileSize: number;
}

export interface ConfirmUploadDto {
  filePath: string;
  eventSlug: string;
  name: string;
  mimeType: string;
  fileSize: number;
  description?: string;
  tags?: string[];
  defaultMode?: 'overlay' | 'full';
  defaultLoop?: boolean;
  defaultMuted?: boolean;
  defaultFit?: 'cover' | 'contain';
  defaultOpacity?: number;
}

@Injectable()
export class MediaLibraryService {
  constructor(
    @InjectModel(MediaItem.name)
    private readonly mediaModel: Model<MediaItemDocument>,
    @InjectModel(LiveStreamConfig.name)
    private readonly configModel: Model<LiveStreamConfigDocument>,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: typeof admin,
  ) {}

  async list(eventSlug: string): Promise<MediaItem[]> {
    return this.mediaModel
      .find({ eventSlug })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async create(
    dto: CreateMediaItemDto,
    file: Express.Multer.File,
    uploadedBy?: string,
  ): Promise<MediaItem> {
    const bucket = this.firebaseAdmin.storage().bucket();
    const timestamp = Date.now();

    // Determinar extensión
    const ext =
      file.mimetype === 'image/png'
        ? 'png'
        : file.mimetype === 'image/jpeg'
          ? 'jpg'
          : file.mimetype === 'image/gif'
            ? 'gif'
            : file.mimetype === 'video/webm'
              ? 'webm'
              : file.mimetype === 'video/mp4'
                ? 'mp4'
                : file.mimetype === 'video/mpeg'
                  ? 'mpg'
                  : file.mimetype === 'audio/mpeg' || file.mimetype === 'audio/mp3'
                    ? 'mp3'
                    : file.mimetype === 'audio/wav'
                      ? 'wav'
                      : file.mimetype === 'audio/ogg'
                        ? 'ogg'
                        : 'bin';

    // Generar ID temporal para nombre de archivo
    const tempId = `${timestamp}_${Math.random().toString(36).substring(7)}`;
    const filePath = `live-media/${dto.eventSlug}/items/${tempId}.${ext}`;
    const fileRef = bucket.file(filePath);

    // Upload a Firebase Storage
    await fileRef.save(file.buffer, {
      metadata: { contentType: file.mimetype },
      public: true,
    });

    await fileRef.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    // Determinar tipo
    const mediaType = file.mimetype.startsWith('video/')
      ? 'video'
      : file.mimetype.startsWith('audio/')
        ? 'audio'
        : file.mimetype === 'image/gif'
          ? 'gif'
          : 'image';

    // Crear documento
    const item = await this.mediaModel.create({
      eventSlug: dto.eventSlug,
      name: dto.name,
      type: mediaType,
      url: publicUrl,
      description: dto.description || '',
      tags: dto.tags || [],
      fileSize: file.size,
      mimeType: file.mimetype,
      uploadedBy: uploadedBy || '',
      defaultMode: dto.defaultMode || 'full',
      defaultLoop: dto.defaultLoop ?? false,
      defaultMuted: dto.defaultMuted ?? true,
      defaultFit: dto.defaultFit || 'cover',
      defaultOpacity: dto.defaultOpacity ?? 1,
    });

    return item.toObject();
  }

  async findById(id: string): Promise<MediaItem> {
    const item = await this.mediaModel.findById(id).lean().exec();
    if (!item) {
      throw new NotFoundException(`MediaItem ${id} not found`);
    }
    return item;
  }

  async update(id: string, dto: UpdateMediaItemDto): Promise<MediaItem> {
    const item = await this.mediaModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean()
      .exec();

    if (!item) {
      throw new NotFoundException(`MediaItem ${id} not found`);
    }

    return item;
  }

  async delete(id: string): Promise<void> {
    const item = await this.mediaModel.findById(id).exec();
    if (!item) {
      throw new NotFoundException(`MediaItem ${id} not found`);
    }

    // Opcional: eliminar archivo de Storage
    // Extraer path del URL
    try {
      const url = item.url;
      const match = url.match(/\/live-media\/.+$/);
      if (match) {
        const bucket = this.firebaseAdmin.storage().bucket();
        const filePath = match[0].substring(1); // quitar el /
        await bucket.file(filePath).delete();
      }
    } catch (err) {
      console.warn('Error deleting file from storage:', err);
      // No bloqueamos si falla el delete del archivo
    }

    // Si este item está activo, desactivarlo
    await this.configModel.updateMany(
      { activeMediaItemId: id },
      { $set: { activeMediaItemId: '', mediaEnabled: false } },
    );

    await this.mediaModel.findByIdAndDelete(id).exec();
  }

  async activate(
    id: string,
    eventSlug: string,
    overrides?: MediaOverrides,
  ): Promise<void> {
    // Verificar que el item existe
    const item = await this.findById(id);

    if (item.eventSlug !== eventSlug) {
      throw new BadRequestException('MediaItem does not belong to this event');
    }

    // Determinar si es visual o audio
    const isAudio = item.type === 'audio';
    const isVisual = ['image', 'gif', 'video'].includes(item.type);

    // Actualizar config del evento
    const updates: any = {
      activeMediaItemId: id, // Legacy
      mediaEnabled: true,
      // Legacy fields para backward compatibility
      mediaUrl: item.url,
      mediaType: item.type,
    };

    // Asignar a la capa correspondiente
    if (isAudio) {
      updates.activeAudioItemId = id;
    } else if (isVisual) {
      updates.activeVisualItemId = id;
    }

    // Aplicar overrides si existen
    if (overrides?.mode !== undefined) updates.mediaMode = overrides.mode;
    if (overrides?.loop !== undefined) updates.mediaLoop = overrides.loop;
    if (overrides?.muted !== undefined) updates.mediaMuted = overrides.muted;
    if (overrides?.fit !== undefined) updates.mediaFit = overrides.fit;
    if (overrides?.opacity !== undefined)
      updates.mediaOpacity = overrides.opacity;

    await this.configModel.updateOne({ eventSlug }, { $set: updates });
  }

  async deactivate(
    eventSlug: string,
    type: 'visual' | 'audio' | 'all' = 'all',
  ): Promise<void> {
    const updates: any = {};

    if (type === 'all') {
      updates.mediaEnabled = false;
      updates.activeMediaItemId = '';
      updates.activeVisualItemId = '';
      updates.activeAudioItemId = '';
      // Limpiar también campos legacy
      updates.mediaUrl = '';
      updates.mediaType = 'image';
    } else if (type === 'visual') {
      updates.activeVisualItemId = '';
      // Limpiar campos legacy también
      updates.activeMediaItemId = '';
      updates.mediaUrl = '';
      updates.mediaType = 'image';
      
      // Si no hay audio activo tampoco, deshabilitar todo
      const config = await this.configModel
        .findOne({ eventSlug })
        .lean()
        .exec();
      if (!config?.activeAudioItemId) {
        updates.mediaEnabled = false;
      }
    } else if (type === 'audio') {
      updates.activeAudioItemId = '';
      // Si no hay visual activo tampoco, deshabilitar todo
      const config = await this.configModel
        .findOne({ eventSlug })
        .lean()
        .exec();
      if (!config?.activeVisualItemId) {
        updates.mediaEnabled = false;
        // Si no hay ninguno, limpiar legacy también
        updates.activeMediaItemId = '';
        updates.mediaUrl = '';
        updates.mediaType = 'image';
      }
    }

    await this.configModel.updateOne({ eventSlug }, { $set: updates });
  }

  /**
   * Obtiene la configuración efectiva de media para un evento
   * (merge de defaults del item + overrides del config)
   * Ahora soporta visual y audio simultáneos
   */
  async getEffectiveConfig(eventSlug: string) {
    const config = await this.configModel.findOne({ eventSlug }).lean().exec();
    if (!config) {
      return { enabled: false };
    }

    // Incluir frame info
    const result: any = {
      enabled: config.mediaEnabled ?? false,
      showFrame: config.showFrame ?? false,
      frameUrl: config.frameUrl || '',
    };

    // Procesar capa visual (video/imagen/gif)
    if (config.activeVisualItemId) {
      const visualItem = await this.mediaModel
        .findById(config.activeVisualItemId)
        .lean()
        .exec();

      if (visualItem) {
        result.visual = {
          item: {
            id: visualItem._id,
            name: visualItem.name,
            type: visualItem.type,
            url: visualItem.url,
            thumbnailUrl: visualItem.thumbnailUrl,
          },
          config: {
            mode: config.mediaMode ?? visualItem.defaultMode,
            loop: config.mediaLoop ?? visualItem.defaultLoop,
            muted: config.mediaMuted ?? visualItem.defaultMuted,
            fit: config.mediaFit ?? visualItem.defaultFit,
            opacity: config.mediaOpacity ?? visualItem.defaultOpacity,
          },
        };
      }
    }

    // Procesar capa de audio
    if (config.activeAudioItemId) {
      const audioItem = await this.mediaModel
        .findById(config.activeAudioItemId)
        .lean()
        .exec();

      if (audioItem) {
        result.audio = {
          item: {
            id: audioItem._id,
            name: audioItem.name,
            type: audioItem.type,
            url: audioItem.url,
          },
          config: {
            loop: config.mediaLoop ?? audioItem.defaultLoop,
            muted: config.mediaMuted ?? audioItem.defaultMuted,
            opacity: config.mediaOpacity ?? audioItem.defaultOpacity,
          },
        };
      }
    }

    // Legacy: mantener compatibilidad con activeMediaItemId
    if (!result.visual && !result.audio && config.activeMediaItemId) {
      const item = await this.mediaModel
        .findById(config.activeMediaItemId)
        .lean()
        .exec();

      if (item) {
        result.item = {
          id: item._id,
          name: item.name,
          type: item.type,
          url: item.url,
          thumbnailUrl: item.thumbnailUrl,
        };

        result.config = {
          mode: config.mediaMode ?? item.defaultMode,
          loop: config.mediaLoop ?? item.defaultLoop,
          muted: config.mediaMuted ?? item.defaultMuted,
          fit: config.mediaFit ?? item.defaultFit,
          opacity: config.mediaOpacity ?? item.defaultOpacity,
        };
      }
    }

    return result;
  }

  // Reservar path en Firebase Storage para upload directo desde el cliente con Firebase Web SDK
  async requestUpload(dto: RequestUploadDto): Promise<{ filePath: string }> {
    const allowedMimes = ['video/mp4', 'video/webm', 'video/mpeg'];
    if (!allowedMimes.includes(dto.mimeType)) {
      throw new BadRequestException('Solo se permiten videos (MP4/WEBM/MPEG) para upload directo');
    }

    const maxSize = 1024 * 1024 * 1024; // 1 GB
    if (dto.fileSize > maxSize) {
      throw new BadRequestException('Archivo muy grande (máx 1GB)');
    }

    const ext =
      dto.mimeType === 'video/mp4' ? 'mp4' : dto.mimeType === 'video/webm' ? 'webm' : 'mpg';

    const timestamp = Date.now();
    const tempId = `${timestamp}_${Math.random().toString(36).substring(7)}`;
    const filePath = `live-media/${dto.eventSlug}/items/${tempId}.${ext}`;

    return { filePath };
  }

  // Confirmar upload directo: hacer público + crear documento MongoDB
  async confirmUpload(dto: ConfirmUploadDto, uploadedBy?: string): Promise<MediaItem> {
    const bucket = this.firebaseAdmin.storage().bucket();
    const fileRef = bucket.file(dto.filePath);

    const [exists] = await fileRef.exists();
    if (!exists) {
      throw new NotFoundException('Archivo no encontrado en Storage. El upload puede haber fallado.');
    }

    await fileRef.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${dto.filePath}`;

    const mediaType = dto.mimeType.startsWith('video/') ? 'video' : 'image';

    const item = await this.mediaModel.create({
      eventSlug: dto.eventSlug,
      name: dto.name,
      type: mediaType,
      url: publicUrl,
      description: dto.description || '',
      tags: dto.tags || [],
      fileSize: dto.fileSize,
      mimeType: dto.mimeType,
      uploadedBy: uploadedBy || '',
      defaultMode: dto.defaultMode || 'full',
      defaultLoop: dto.defaultLoop ?? false,
      defaultMuted: dto.defaultMuted ?? true,
      defaultFit: dto.defaultFit || 'cover',
      defaultOpacity: dto.defaultOpacity ?? 1,
    });

    return item.toObject();
  }
}
