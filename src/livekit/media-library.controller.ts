/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  IsArray,
  IsPositive,
} from 'class-validator';
import * as mediaLibraryService from './media-library.service';
import { FirebaseAuthGuard } from 'src/common/guards/firebase-auth.guard';
import { MediaLibraryService } from './media-library.service';

export class CreateMediaItemDto {
  @IsString()
  eventSlug: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(['overlay', 'full'])
  defaultMode?: 'overlay' | 'full';

  @IsOptional()
  @IsBoolean()
  defaultLoop?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultMuted?: boolean;

  @IsOptional()
  @IsEnum(['cover', 'contain'])
  defaultFit?: 'cover' | 'contain';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  defaultOpacity?: number;
}

export class UpdateMediaItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(['overlay', 'full'])
  defaultMode?: 'overlay' | 'full';

  @IsOptional()
  @IsBoolean()
  defaultLoop?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultMuted?: boolean;

  @IsOptional()
  @IsEnum(['cover', 'contain'])
  defaultFit?: 'cover' | 'contain';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  defaultOpacity?: number;
}

export class ActivateMediaDto {
  @IsString()
  eventSlug: string;

  @IsOptional()
  overrides?: mediaLibraryService.MediaOverrides;
}

export class RequestUploadBodyDto {
  @IsString()
  eventSlug: string;

  @IsString()
  name: string;

  @IsString()
  mimeType: string;

  @IsNumber()
  @IsPositive()
  fileSize: number;
}

export class ConfirmUploadBodyDto {
  @IsString()
  filePath: string;

  @IsString()
  eventSlug: string;

  @IsString()
  name: string;

  @IsString()
  mimeType: string;

  @IsNumber()
  @IsPositive()
  fileSize: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(['overlay', 'full'])
  defaultMode?: 'overlay' | 'full';

  @IsOptional()
  @IsBoolean()
  defaultLoop?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultMuted?: boolean;

  @IsOptional()
  @IsEnum(['cover', 'contain'])
  defaultFit?: 'cover' | 'contain';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  defaultOpacity?: number;
}

@Controller('livekit/media-library')
export class MediaLibraryController {
  constructor(private readonly service: MediaLibraryService) {
    console.log('✅ MediaLibraryController initialized');
  }

  // GET /livekit/media-library?eventSlug=xxx
  @Get()
  async list(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) {
      throw new BadRequestException('eventSlug is required');
    }
    const items = await this.service.list(eventSlug);
    return { items };
  }

  // GET /livekit/media-library/effective-config?eventSlug=xxx
  @Get('effective-config')
  async getEffectiveConfig(@Query('eventSlug') eventSlug: string) {
    if (!eventSlug) {
      throw new BadRequestException('eventSlug is required');
    }
    const config = await this.service.getEffectiveConfig(eventSlug);
    return config || { enabled: false };
  }

  // GET /livekit/media-library/:id
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const item = await this.service.findById(id);
    return item;
  }

  // POST /livekit/media-library/upload
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @UseGuards(FirebaseAuthGuard)
  async upload(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('file is required');
    }

    const allowed = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/mpeg',
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/ogg',
    ];

    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Only PNG/JPEG/GIF, MP4/WEBM/MPEG or MP3/WAV/OGG allowed');
    }

    const isVideo = file.mimetype.startsWith('video/');
    const isAudio = file.mimetype.startsWith('audio/');
    const maxImage = 10 * 1024 * 1024;
    const maxVideo = 60 * 1024 * 1024;
    const maxAudio = 20 * 1024 * 1024;
    const max = isVideo ? maxVideo : isAudio ? maxAudio : maxImage;
    
    if (file.size > max) {
      throw new BadRequestException(
        isVideo 
          ? 'Video too large (max 60MB)' 
          : isAudio
          ? 'Audio too large (max 20MB)'
          : 'Image too large (max 10MB)',
      );
    }

    // Parse DTO from form data manually
    const dto: CreateMediaItemDto = {
      eventSlug: req.body.eventSlug,
      name: req.body.name,
      description: req.body.description,
      tags: req.body.tags ? JSON.parse(req.body.tags) : undefined,
      defaultMode: req.body.defaultMode,
      defaultLoop: req.body.defaultLoop === 'true',
      defaultMuted: req.body.defaultMuted === 'true',
      defaultFit: req.body.defaultFit,
      defaultOpacity: req.body.defaultOpacity
        ? parseFloat(req.body.defaultOpacity)
        : undefined,
    };

    const uid = req.user?.uid;
    const item = await this.service.create(dto, file, uid);

    return { ok: true, item };
  }

  // PATCH /livekit/media-library/:id
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateMediaItemDto) {
    const item = await this.service.update(id, dto);
    return { ok: true, item };
  }

  // DELETE /livekit/media-library/:id
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }

  // POST /livekit/media-library/:id/activate
  @Post(':id/activate')
  async activate(@Param('id') id: string, @Body() dto: ActivateMediaDto) {
    await this.service.activate(id, dto.eventSlug, dto.overrides);
    return { ok: true };
  }

  // POST /livekit/media-library/deactivate
  @Post('deactivate')
  async deactivate(
    @Body() body: { eventSlug: string; type?: 'visual' | 'audio' | 'all' },
  ) {
    if (!body.eventSlug) {
      throw new BadRequestException('eventSlug is required');
    }
    await this.service.deactivate(body.eventSlug, body.type || 'all');
    return { ok: true };
  }

  // POST /livekit/media-library/request-upload
  // Genera URL firmada para que el cliente suba directamente a Firebase Storage
  @Post('request-upload')
  @UseGuards(FirebaseAuthGuard)
  async requestUpload(@Body() body: RequestUploadBodyDto) {
    const result = await this.service.requestUpload(body);
    return result;
  }

  // POST /livekit/media-library/confirm-upload
  // Confirma que el archivo ya está en Firebase Storage y crea el documento en MongoDB
  @Post('confirm-upload')
  @UseGuards(FirebaseAuthGuard)
  async confirmUpload(@Req() req: any, @Body() body: ConfirmUploadBodyDto) {
    const uid = req.user?.uid;
    const item = await this.service.confirmUpload(body, uid);
    return { ok: true, item };
  }
}
