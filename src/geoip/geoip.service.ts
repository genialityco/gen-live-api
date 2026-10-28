import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import * as os from 'os';
import * as tar from 'tar';
import maxmind, { AsnResponse, CountryResponse, Reader } from 'maxmind';

// País (campañas, reportes) y red/operador dueño de la IP (bloqueos de red)
const EDITIONS = ['GeoLite2-Country', 'GeoLite2-ASN'] as const;
type Edition = (typeof EDITIONS)[number];
const DATA_DIR = path.resolve(process.cwd(), 'data', 'geoip');
const dbPath = (edition: Edition) => path.join(DATA_DIR, `${edition}.mmdb`);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // re-descargar si la DB tiene más de 7 días
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // chequeo semanal

export interface GeoCountry {
  iso: string; // código ISO-3166-1 alpha-2, ej: 'CO'
}

export interface GeoAsn {
  asn: number; // número de sistema autónomo, ej: 3816
  org: string; // organización dueña de la red, ej: 'COLOMBIA TELECOMUNICACIONES S.A. ESP BIC'
}

/**
 * Resuelve IP → país (GeoLite2-Country) y IP → red/operador (GeoLite2-ASN)
 * usando las bases locales de MaxMind.
 * - Carga los archivos .mmdb en memoria y resuelve localmente (sin llamadas externas por request).
 * - Se auto-descargan/actualizan desde MaxMind si hay `GEOIP_LICENSE_KEY`.
 * - Degrada de forma segura: si no hay key ni archivo, los lookups devuelven null.
 */
@Injectable()
export class GeoipService implements OnModuleInit {
  private readonly logger = new Logger(GeoipService.name);
  private countryReader: Reader<CountryResponse> | null = null;
  private asnReader: Reader<AsnResponse> | null = null;
  private updating = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.loadReaders(); // carga los archivos existentes si los hay
    void this.ensureFresh(); // descarga/actualiza en segundo plano, sin bloquear el arranque
    setInterval(() => void this.ensureFresh(), UPDATE_INTERVAL_MS).unref();
  }

  /** Resuelve una IP a su país. Devuelve null si no se puede determinar. */
  lookupCountry(ip: string): GeoCountry | null {
    const res = this.lookup(this.countryReader, ip);
    const iso = res?.country?.iso_code;
    return iso ? { iso } : null;
  }

  /** Resuelve una IP a la red (sistema autónomo) que la anuncia. */
  lookupAsn(ip: string): GeoAsn | null {
    const res = this.lookup(this.asnReader, ip);
    return res?.autonomous_system_number
      ? {
          asn: res.autonomous_system_number,
          org: res.autonomous_system_organization ?? '',
        }
      : null;
  }

  /** Indica si la geolocalización por país está operativa (archivo cargado). */
  get isReady(): boolean {
    return this.countryReader !== null;
  }

  private lookup<T extends CountryResponse | AsnResponse>(
    reader: Reader<T> | null,
    ip: string,
  ): T | null {
    if (!reader || !ip) return null;
    // Normaliza IPv4 mapeada en IPv6 (ej: '::ffff:181.49.1.1')
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!maxmind.validate(clean)) return null;
    try {
      return reader.get(clean);
    } catch {
      return null;
    }
  }

  private async loadReaders(): Promise<void> {
    this.countryReader = await this.open<CountryResponse>('GeoLite2-Country');
    this.asnReader = await this.open<AsnResponse>('GeoLite2-ASN');
  }

  private async open<T extends CountryResponse | AsnResponse>(
    edition: Edition,
  ): Promise<Reader<T> | null> {
    try {
      const reader = await maxmind.open<T>(dbPath(edition));
      this.logger.log(`Base GeoIP cargada desde ${dbPath(edition)}`);
      return reader;
    } catch {
      return null;
    }
  }

  private async ensureFresh(): Promise<void> {
    if (this.updating) return;
    const licenseKey = this.config.get<string>('GEOIP_LICENSE_KEY');
    if (!licenseKey) {
      if (!this.countryReader) {
        this.logger.warn(
          'GEOIP_LICENSE_KEY no configurada y sin base local: la geolocalización por IP queda deshabilitada.',
        );
      }
      return;
    }

    this.updating = true;
    try {
      let updated = false;
      for (const edition of EDITIONS) {
        if (!(await this.isStale(edition))) continue;
        try {
          await this.download(licenseKey, edition);
          updated = true;
          this.logger.log(`Base GeoIP ${edition} actualizada desde MaxMind.`);
        } catch (err) {
          this.logger.error(
            `No se pudo actualizar la base GeoIP ${edition}: ${(err as Error).message}`,
          );
        }
      }
      if (updated) await this.loadReaders();
    } finally {
      this.updating = false;
    }
  }

  private async isStale(edition: Edition): Promise<boolean> {
    try {
      const stat = await fs.stat(dbPath(edition));
      return Date.now() - stat.mtimeMs > MAX_AGE_MS;
    } catch {
      return true; // no existe → descargar
    }
  }

  private async download(licenseKey: string, edition: Edition): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const url =
      `https://download.maxmind.com/app/geoip_download` +
      `?edition_id=${edition}&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`;

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
      if (!mmdb)
        throw new Error('no se encontró el .mmdb en el paquete descargado');

      // Escritura atómica: copia a archivo temporal y renombra
      const target = dbPath(edition);
      const tmpDb = `${target}.tmp`;
      await fs.copyFile(mmdb, tmpDb);
      await fs.rename(tmpDb, target);
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
