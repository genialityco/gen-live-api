/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MediaItem, MediaItemDocument } from './schemas/media-item.schema';
import {
  LiveStreamConfig,
  LiveStreamConfigDocument,
} from './schemas/live-stream-config.schema';
import * as admin from 'firebase-admin';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse') as { PDFParse: new (opts: { data: Buffer }) => { getInfo(): Promise<{ total: number }> } };
const execAsync = promisify(exec);

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

  private isPresentation(mimeType: string): boolean {
    return (
      mimeType === 'application/pdf' ||
      mimeType.includes('presentationml') ||
      mimeType.includes('powerpoint')
    );
  }

  private async uploadBufferToStorage(
    buffer: Buffer,
    storagePath: string,
    mimeType: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bucket: any,
  ): Promise<string> {
    const fileRef = bucket.file(storagePath);
    await fileRef.save(buffer, { metadata: { contentType: mimeType }, public: true });
    await fileRef.makePublic();
    // Usar Firebase Storage download URL (firebasestorage.googleapis.com) en lugar de GCS raw
    // URL. La URL de Firebase incluye headers CORS necesarios para fetch/range requests del browser
    // (ej: pdf.js), mientras que storage.googleapis.com no tiene CORS configurado por defecto.
    const encodedPath = encodeURIComponent(storagePath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media`;
  }

  private async processPdf(
    buffer: Buffer,
    eventSlug: string,
    tempId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bucket: any,
  ): Promise<{ url: string; totalPages: number }> {
    const parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();
    const totalPages = info.total;
    const storagePath = `live-media/${eventSlug}/items/${tempId}.pdf`;
    const url = await this.uploadBufferToStorage(buffer, storagePath, 'application/pdf', bucket);
    return { url, totalPages };
  }

  private async processPptx(
    buffer: Buffer,
    eventSlug: string,
    tempId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bucket: any,
  ): Promise<{ url: string; slides: string[]; totalPages: number }> {
    // Check LibreOffice availability
    try {
      await execAsync('which libreoffice || libreoffice --version');
    } catch {
      throw new InternalServerErrorException(
        'LibreOffice no está instalado en el servidor. No se pueden procesar archivos PPTX.',
      );
    }

    const tmpDir = `/tmp/pptx-${tempId}`;
    const ext = buffer[0] === 0x50 ? 'pptx' : 'ppt'; // PK zip signature for pptx
    const tmpFile = path.join(tmpDir, `presentation.${ext}`);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFile, buffer);

    try {
      await execAsync(
        `libreoffice --headless --convert-to png --outdir "${tmpDir}" "${tmpFile}"`,
      );

      const allFiles = await fs.readdir(tmpDir);
      const pngFiles = allFiles
        .filter((f) => f.endsWith('.png'))
        .sort((a, b) => {
          const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
          const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
          return numA - numB;
        });

      if (pngFiles.length === 0) {
        throw new InternalServerErrorException(
          'LibreOffice no pudo convertir la presentación a imágenes.',
        );
      }

      const slideUrls = await Promise.all(
        pngFiles.map(async (f, i) => {
          const imgBuffer = await fs.readFile(path.join(tmpDir, f));
          return this.uploadBufferToStorage(
            imgBuffer,
            `live-media/${eventSlug}/slides/${tempId}/slide_${i}.png`,
            'image/png',
            bucket,
          );
        }),
      );

      return {
        url: slideUrls[0],
        slides: slideUrls,
        totalPages: slideUrls.length,
      };
    } finally {
      // Cleanup temp dir
      try {
        fsSync.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  async create(
    dto: CreateMediaItemDto,
    file: Express.Multer.File,
    uploadedBy?: string,
  ): Promise<MediaItem> {
    const bucket = this.firebaseAdmin.storage().bucket();
    const timestamp = Date.now();
    const tempId = `${timestamp}_${Math.random().toString(36).substring(7)}`;

    // Determinar tipo
    const isPresentation = this.isPresentation(file.mimetype);
    const mediaType: MediaItem['type'] = isPresentation
      ? 'presentation'
      : file.mimetype.startsWith('video/')
        ? 'video'
        : file.mimetype.startsWith('audio/')
          ? 'audio'
          : file.mimetype === 'image/gif'
            ? 'gif'
            : 'image';

    // Determinar extensión
    const extMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'video/webm': 'webm',
      'video/mp4': 'mp4',
      'video/mpeg': 'mpg',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
    };
    const ext = extMap[file.mimetype] ?? 'bin';

    // Para presentaciones, procesamiento especial
    let publicUrl = '';
    let slideUrls: string[] | undefined;
    let totalPages: number | undefined;
    let presentationMimeType: string | undefined;

    if (isPresentation) {
      presentationMimeType = file.mimetype;
      if (file.mimetype === 'application/pdf') {
        const result = await this.processPdf(file.buffer, dto.eventSlug, tempId, bucket);
        publicUrl = result.url;
        totalPages = result.totalPages;
      } else {
        const result = await this.processPptx(file.buffer, dto.eventSlug, tempId, bucket);
        publicUrl = result.url;
        slideUrls = result.slides;
        totalPages = result.totalPages;
      }
    } else {
      // Upload normal
      const filePath = `live-media/${dto.eventSlug}/items/${tempId}.${ext}`;
      const fileRef = bucket.file(filePath);
      await fileRef.save(file.buffer, {
        metadata: { contentType: file.mimetype },
        public: true,
      });
      await fileRef.makePublic();
      publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    }

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
      defaultMode: isPresentation ? 'full' : (dto.defaultMode || 'full'),
      defaultLoop: dto.defaultLoop ?? true,
      defaultMuted: dto.defaultMuted ?? false,
      defaultFit: dto.defaultFit || 'cover',
      defaultOpacity: dto.defaultOpacity ?? 1,
      ...(totalPages !== undefined && { totalPages }),
      ...(slideUrls !== undefined && { slides: slideUrls }),
      ...(presentationMimeType !== undefined && { presentationMimeType }),
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
    const isVisual = ['image', 'gif', 'video', 'presentation'].includes(item.type);

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

    // Incluir frame info y fondo
    const result: any = {
      enabled: config.mediaEnabled ?? false,
      showFrame: config.showFrame ?? false,
      frameUrl: config.frameUrl || '',
      backgroundUrl: config.backgroundUrl || '',
      backgroundType: config.backgroundType || 'image',
      backgroundColor: config.backgroundColor || '#000000',
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
            totalPages: visualItem.totalPages,
            slides: visualItem.slides,
            presentationMimeType: visualItem.presentationMimeType,
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
      defaultLoop: dto.defaultLoop ?? true,
      defaultMuted: dto.defaultMuted ?? false,
      defaultFit: dto.defaultFit || 'cover',
      defaultOpacity: dto.defaultOpacity ?? 1,
    });

    return item.toObject();
  }
}
