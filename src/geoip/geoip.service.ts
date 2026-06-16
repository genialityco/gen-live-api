import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import * as os from 'os';
import * as tar from 'tar';
import maxmind, { CountryResponse, Reader } from 'maxmind';

const EDITION = 'GeoLite2-Country';
const DATA_DIR = path.resolve(process.cwd(), 'data', 'geoip');
const DB_PATH = path.join(DATA_DIR, `${EDITION}.mmdb`);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // re-descargar si la DB tiene más de 7 días
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // chequeo semanal

export interface GeoCountry {
  iso: string; // código ISO-3166-1 alpha-2, ej: 'CO'
}

/**
 * Resuelve IP → país usando la base de datos local de MaxMind (GeoLite2-Country).
 * - Carga el archivo .mmdb en memoria y resuelve localmente (sin llamadas externas por request).
 * - Se auto-descarga/actualiza desde MaxMind si hay `GEOIP_LICENSE_KEY`.
 * - Degrada de forma segura: si no hay key ni archivo, `lookupCountry` devuelve null.
 */
@Injectable()
export class GeoipService implements OnModuleInit {
  private readonly logger = new Logger(GeoipService.name);
  private reader: Reader<CountryResponse> | null = null;
  private updating = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.loadReader(); // carga el archivo existente si lo hay
    void this.ensureFresh(); // descarga/actualiza en segundo plano, sin bloquear el arranque
    setInterval(() => void this.ensureFresh(), UPDATE_INTERVAL_MS).unref();
  }

  /** Resuelve una IP a su país. Devuelve null si no se puede determinar. */
  lookupCountry(ip: string): GeoCountry | null {
    if (!this.reader || !ip) return null;
    // Normaliza IPv4 mapeada en IPv6 (ej: '::ffff:181.49.1.1')
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!maxmind.validate(clean)) return null;
    try {
      const res = this.reader.get(clean);
      const iso = res?.country?.iso_code;
      return iso ? { iso } : null;
    } catch {
      return null;
    }
  }

  /** Indica si la geolocalización está operativa (archivo cargado). */
  get isReady(): boolean {
    return this.reader !== null;
  }

  private async loadReader(): Promise<void> {
    try {
      this.reader = await maxmind.open<CountryResponse>(DB_PATH);
      this.logger.log(`Base GeoIP cargada desde ${DB_PATH}`);
    } catch {
      this.reader = null;
    }
  }

  private async ensureFresh(): Promise<void> {
    if (this.updating) return;
    const licenseKey = this.config.get<string>('GEOIP_LICENSE_KEY');
    if (!licenseKey) {
      if (!this.reader) {
        this.logger.warn(
          'GEOIP_LICENSE_KEY no configurada y sin base local: la geolocalización por IP queda deshabilitada.',
        );
      }
      return;
    }

    let needsUpdate = true;
    try {
      const stat = await fs.stat(DB_PATH);
      needsUpdate = Date.now() - stat.mtimeMs > MAX_AGE_MS;
    } catch {
      needsUpdate = true; // no existe → descargar
    }
    if (!needsUpdate) return;

    this.updating = true;
    try {
      await this.download(licenseKey);
      await this.loadReader();
      this.logger.log('Base GeoIP actualizada desde MaxMind.');
    } catch (err) {
      this.logger.error(
        `No se pudo actualizar la base GeoIP: ${(err as Error).message}`,
      );
    } finally {
      this.updating = false;
    }
  }

  private async download(licenseKey: string): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const url =
      `https://download.maxmind.com/app/geoip_download` +
      `?edition_id=${EDITION}&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`;

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`descarga MaxMind falló (HTTP ${res.status})`);
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'geoip-'));
    try {
      const tgzPath = path.join(tmpDir, 'db.tar.gz');
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tgzPath),
      );

      await tar.x({ file: tgzPath, cwd: tmpDir });

      const mmdb = await this.findMmdb(tmpDir);
      if (!mmdb) throw new Error('no se encontró el .mmdb en el paquete descargado');

      // Escritura atómica: copia a archivo temporal y renombra
      const tmpDb = `${DB_PATH}.tmp`;
      await fs.copyFile(mmdb, tmpDb);
      await fs.rename(tmpDb, DB_PATH);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async findMmdb(dir: string): Promise<string | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = await this.findMmdb(full);
        if (found) return found;
      } else if (e.name.endsWith('.mmdb')) {
        return full;
      }
    }
    return null;
  }
}
