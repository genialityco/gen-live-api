/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Inject } from '@nestjs/common';
import { FIREBASE_ADMIN } from '../auth/firebase-admin.provider';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class StorageService {
  constructor(@Inject(FIREBASE_ADMIN) private readonly admin: any) {}

  /**
   * Sube un archivo a Firebase Storage
   * @param file Buffer del archivo
   * @param filename Nombre del archivo
   * @param folder Carpeta donde guardarlo (ej: 'logos', 'covers', 'avatars')
   * @param organizationId ID de la organización (para organizar archivos)
   * @returns URL pública del archivo
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    folder: string,
    organizationId: string,
  ): Promise<string> {
    const bucket = this.admin
      .storage()
      .bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const uniqueId = uuidv4();
    const extension = filename.split('.').pop();
    const storagePath = `organizations/${organizationId}/${folder}/${uniqueId}.${extension}`;

    const fileUpload = bucket.file(storagePath);

    await fileUpload.save(file, {
      metadata: {
        contentType: this.getContentType(extension),
        metadata: {
          firebaseStorageDownloadTokens: uniqueId,
        },
      },
      public: true,
    });

    // Generar URL pública
    return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
  }

  /**
   * Elimina un archivo de Firebase Storage
   * @param fileUrl URL del archivo a eliminar
   */
  async deleteFile(fileUrl: string): Promise<void> {
    try {
      const bucket = this.admin
        .storage()
        .bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const fileName = this.extractFilePathFromUrl(fileUrl);
      await bucket.file(fileName).delete();
    } catch (error) {
      console.error('Error deleting file:', error);
      // No lanzamos error si el archivo no existe
    }
  }

  private extractFilePathFromUrl(url: string): string {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    const pattern = `https://storage.googleapis.com/${bucketName}/`;
    return url.replace(pattern, '');
  }

  private getContentType(extension: string | undefined): string {
    const types: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      ico: 'image/x-icon',
    };
    return types[extension?.toLowerCase() || ''] || 'application/octet-stream';
  }
}
