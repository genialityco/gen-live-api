/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isIPv4, isIPv6 } from 'net';
import { Model } from 'mongoose';
import { GeoipService } from '../geoip/geoip.service';
import { NetworkBlockReport } from './schemas/network-block-report.schema';
import { EventUser } from './schemas/event-user.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { ReportNetworkBlockDto } from './dtos/report-network-block.dto';

const RECENT_LIMIT = 50;

/**
 * Prefijo de red de la IP (/24 en IPv4, /48 en IPv6): suficiente para que el
 * área de sistemas identifique su red sin guardar la IP de la persona.
 */
export function ipPrefix(ip: string): string | undefined {
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIPv4(clean)) {
    return `${clean.split('.').slice(0, 3).join('.')}.0/24`;
  }
  if (isIPv6(clean)) {
    const [head] = clean.split('::');
    const groups = head.split(':').filter(Boolean);
    while (groups.length < 3) groups.push('0');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return undefined;
}

/** Cuenta por clave y devuelve de mayor a menor */
function countBy<T>(items: T[], key: (t: T) => string | undefined) {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map].sort((a, b) => b[1] - a[1]);
}

/**
 * Bloqueos de red que reportan los asistentes cuando su navegador no logra
 * conectarse al servidor del video (ver VideoNetworkGuard en el frontend).
 */
@Injectable()
export class NetworkReportsService {
  constructor(
    @InjectModel(NetworkBlockReport.name)
    private reportModel: Model<NetworkBlockReport>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    private geoip: GeoipService,
  ) {}

  async report(
    eventId: string,
    uid: string,
    dto: ReportNetworkBlockDto,
    ip: string,
    userAgent: string,
  ) {
    const filter = { eventId, uid, videoHost: dto.videoHost };

    if (dto.recovered) {
      await this.reportModel.updateOne(filter, {
        $set: { recovered: true, recoveredAt: new Date() },
      });
      return { ok: true };
    }
    if (!dto.cause) return { ok: false };

    const eventUser = await this.eventUserModel
      .findOne({ eventId, firebaseUID: uid }, { attendeeId: 1 })
      .lean();
    const asn = this.geoip.lookupAsn(ip);

    const update = {
      $set: {
        cause: dto.cause,
        probes: dto.probes ?? [],
        videoUrl: dto.videoUrl,
        userAgent: userAgent.slice(0, 400),
        mobile: dto.mobile,
        platform: dto.platform,
        connectionType: dto.connectionType,
        ipPrefix: ipPrefix(ip),
        country: this.geoip.lookupCountry(ip)?.iso,
        asn: asn?.asn,
        asnOrg: asn?.org,
        recovered: false,
        lastSeenAt: new Date(),
        ...(eventUser?.attendeeId
          ? { attendeeId: String(eventUser.attendeeId) }
          : {}),
      },
      $inc: { occurrences: 1 },
    };

    try {
      await this.reportModel.updateOne(filter, update, { upsert: true });
    } catch (e) {
      // Dos reportes simultáneos del mismo asistente: el segundo choca con el
      // índice único al insertar; reintentar ya actualiza el existente
      if ((e as { code?: number }).code !== 11000) throw e;
      await this.reportModel.updateOne(filter, update);
    }
    return { ok: true };
  }

  /** Resumen para el control del evento */
  async summary(eventId: string) {
    const docs = await this.reportModel
      .find({ eventId })
      .sort({ lastSeenAt: -1 })
      .lean();

    const attendeeIds = [
      ...new Set(docs.map((d) => d.attendeeId).filter(Boolean)),
    ];
    const attendees = attendeeIds.length
      ? await this.orgAttendeeModel
          .find({ _id: { $in: attendeeIds } }, { name: 1, email: 1 })
          .lean()
      : [];
    const byAttendee = new Map(
      attendees.map((a: any) => [
        String(a._id),
        a as { name: string; email: string },
      ]),
    );

    const orgLabel = (d: (typeof docs)[number]) =>
      d.asnOrg ? `${d.asnOrg}${d.asn ? ` (AS${d.asn})` : ''}` : undefined;

    return {
      total: new Set(docs.map((d) => d.uid)).size,
      recovered: new Set(docs.filter((d) => d.recovered).map((d) => d.uid))
        .size,
      byCause: Object.fromEntries(countBy(docs, (d) => d.cause)),
      byOrg: countBy(docs, orgLabel).map(([org, n]) => ({
        org,
        n,
        // Redes desde donde se reportó, para pasarlas al área de sistemas
        prefixes: [
          ...new Set(
            docs
              .filter((d) => orgLabel(d) === org && d.ipPrefix)
              .map((d) => d.ipPrefix!),
          ),
        ].slice(0, 10),
      })),
      byHost: countBy(docs, (d) => d.videoHost).map(([host, n]) => ({
        host,
        n,
      })),
      byCountry: countBy(docs, (d) => d.country).map(([country, n]) => ({
        country,
        n,
      })),
      recent: docs.slice(0, RECENT_LIMIT).map((d) => {
        const a = d.attendeeId ? byAttendee.get(d.attendeeId) : undefined;
        return {
          name: a?.name ?? null,
          email: a?.email ?? null,
          cause: d.cause,
          videoHost: d.videoHost,
          probes: d.probes,
          org: orgLabel(d) ?? null,
          ipPrefix: d.ipPrefix ?? null,
          country: d.country ?? null,
          mobile: d.mobile ?? null,
          connectionType: d.connectionType ?? null,
          occurrences: d.occurrences,
          recovered: d.recovered,
          lastSeenAt: d.lastSeenAt,
        };
      }),
    };
  }
}
