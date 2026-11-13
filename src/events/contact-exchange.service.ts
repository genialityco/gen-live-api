/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
import {
  ContactExchange,
  ContactShare,
} from './schemas/contact-exchange.schema';
import {
  ContactCard,
  OrgAttendee,
} from '../organizations/schemas/org-attendee.schema';
import { Organization } from '../organizations/schemas/organization.schema';
import { HerdService } from './herd.service';
import {
  SaveContactCardDto,
  UpdateContactConsentDto,
} from './dtos/contact-exchange.dto';

/** Texto de autorización cuando la organización no definió el suyo */
export function defaultContactConsent(orgName: string) {
  return (
    `Autorizo a ${orgName || 'la organización'} a compartir los datos que elijo ` +
    '(correo y/o WhatsApp) únicamente con los colegas con quienes yo acepte ' +
    'intercambiar contacto, para fines de comunicación profesional. Puedo ' +
    'retirar esta autorización en cualquier momento desde «Contactos».'
  );
}

/** Primer nombre, sin caracteres raros y corto */
const firstName = (s: unknown) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 24) ?? '';

const fullName = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

type Side = 'a' | 'b';
type AttendeeDoc = {
  _id: unknown;
  name?: string;
  email?: string;
  phone?: string | null;
  registrationData?: any;
  contactCard?: ContactCard | null;
};

/**
 * Intercambio de contacto entre colegas que se saludaron (saludo entre
 * colegas de los anuncios de manada). Al devolver un saludo nace el par;
 * cada uno decide si comparte su tarjeta de contacto y los datos solo se
 * ven cuando ambos aceptaron (doble consentimiento). El par es de la
 * organización: lo que se acepta en un evento vale en los siguientes.
 *
 * Nada de esto pasa por RTDB: los datos de contacto solo salen del API, y
 * solo hacia las dos personas del par.
 */
@Injectable()
export class ContactExchangeService {
  private readonly logger = new Logger(ContactExchangeService.name);

  constructor(
    @InjectModel(ContactExchange.name)
    private model: Model<ContactExchange>,
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name)
    private attendeeModel: Model<OrgAttendee>,
    @InjectModel(Organization.name)
    private orgModel: Model<Organization>,
    private herd: HerdService,
  ) {}

  private async eventInfo(eventId: string) {
    if (!Types.ObjectId.isValid(eventId)) return null;
    const ev = await this.eventModel
      .findById(eventId, { orgId: 1, herdConfig: 1 })
      .lean();
    if (!ev) return null;
    const g = ev.herdConfig?.greeting;
    return {
      orgId: String(ev.orgId),
      enabled:
        !!ev.herdConfig?.enabled &&
        g?.enabled !== false &&
        !!g?.contactExchange,
    };
  }

  private async attendeeOf(eventId: string, uid: string) {
    const eu = await this.eventUserModel
      .findOne({ eventId, firebaseUID: uid }, { attendeeId: 1 })
      .lean();
    return eu?.attendeeId ? String(eu.attendeeId) : null;
  }

  private async consentText(orgId: string) {
    const org = await this.orgModel
      .findById(orgId, { name: 1, contactExchange: 1 })
      .lean();
    return (
      org?.contactExchange?.consentText?.trim() ||
      defaultContactConsent(org?.name ?? '')
    );
  }

  // ── Señal: devolución de un saludo ───────────────────────────────────────

  /** Quien devolvió el saludo y quien lo envió quedan como par (no lanza) */
  async onGreetingReply(
    eventId: string,
    fromAttendeeId?: string,
    toAttendeeId?: string,
    groupLabel?: string,
  ) {
    try {
      if (!fromAttendeeId || !toAttendeeId) return;
      if (fromAttendeeId === toAttendeeId) return;
      const ev = await this.eventInfo(eventId);
      if (!ev?.enabled) return;
      const [a, b] = [fromAttendeeId, toAttendeeId].sort();
      const upsert = () =>
        this.model.updateOne(
          { orgId: ev.orgId, a, b },
          {
            $addToSet: { events: eventId },
            ...(groupLabel ? { $set: { groupLabel } } : {}),
          },
          { upsert: true },
        );
      // Dos devoluciones simultáneas del mismo par: la segunda reintenta
      await upsert().catch((e: { code?: number }) => {
        if (e?.code === 11000) return upsert();
        throw e;
      });
    } catch (e) {
      this.logger.error(
        `Contactos: no se pudo crear el par en ${eventId}: ${(e as Error).message}`,
      );
    }
  }

  // ── Vista del asistente ──────────────────────────────────────────────────

  async mine(eventId: string, uid: string) {
    const ev = await this.eventInfo(eventId);
    if (!ev) throw new NotFoundException('Event not found');
    const [me, consentText] = await Promise.all([
      this.attendeeOf(eventId, uid),
      this.consentText(ev.orgId),
    ]);
    const empty = {
      visible: ev.enabled,
      enabled: ev.enabled,
      consentText,
      card: null,
      defaults: null,
      pairs: [],
    };
    if (!me) return empty;

    const pairs = await this.model
      .find({ orgId: ev.orgId, $or: [{ a: me }, { b: me }], blockedBy: null })
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();
    const ids = [
      ...new Set([me, ...pairs.map((p) => (p.a === me ? p.b : p.a))]),
    ].filter((id) => Types.ObjectId.isValid(id));
    const docs = (await this.attendeeModel
      .find(
        { _id: { $in: ids } },
        {
          name: 1,
          email: 1,
          phone: 1,
          registrationData: 1,
          contactCard: 1,
        },
      )
      .lean()) as unknown as AttendeeDoc[];
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const titles = await this.herd.formalTitles(eventId, docs);
    const withTitle = (id: string, name: string) => {
      const t = titles.get(id);
      return t && name ? `${t} ${name}` : name;
    };
    const meDoc = byId.get(me);
    const myCard = meDoc?.contactCard ?? null;

    const items = pairs.map((p) => {
      const side: Side = p.a === me ? 'a' : 'b';
      const otherId = side === 'a' ? p.b : p.a;
      const other = byId.get(otherId);
      const mineShare: ContactShare | null = side === 'a' ? p.aShare : p.bShare;
      const theirShare: ContactShare | null =
        side === 'a' ? p.bShare : p.aShare;
      const theirCard = other?.contactCard ?? null;
      const theyAccepted = !!theirShare && !!theirCard;
      const mutual = !!mineShare && !!myCard && theyAccepted;
      const dismissedAt = side === 'a' ? p.aDismissedAt : p.bDismissedAt;
      return {
        id: String(p._id),
        status: mutual
          ? ('mutual' as const)
          : mineShare
            ? ('waiting' as const)
            : ('pending' as const),
        dismissed: !mineShare && !!dismissedAt,
        theyAccepted,
        inEvent: (p.events ?? []).includes(eventId),
        groupLabel: p.groupLabel ?? null,
        // Antes del intercambio solo el primer nombre (como en el saludo)
        name: withTitle(
          otherId,
          mutual
            ? fullName(other?.name) || firstName(other?.name)
            : firstName(other?.name),
        ),
        contact:
          mutual && theirCard
            ? {
                email: theirCard.email ?? null,
                whatsapp: theirCard.whatsapp ?? null,
                note: theirCard.note ?? null,
              }
            : null,
        since: (p as { createdAt?: Date }).createdAt ?? null,
      };
    });

    return {
      visible: ev.enabled || items.length > 0,
      enabled: ev.enabled,
      consentText,
      card: myCard
        ? {
            email: myCard.email ?? null,
            whatsapp: myCard.whatsapp ?? null,
            note: myCard.note ?? null,
            consentAt: myCard.consentAt,
          }
        : null,
      defaults: {
        email: meDoc?.email ?? null,
        whatsapp: meDoc?.phone ?? null,
      },
      pairs: items,
    };
  }

  // ── Tarjeta de contacto ──────────────────────────────────────────────────

  private async requireMe(eventId: string, uid: string) {
    const ev = await this.eventInfo(eventId);
    if (!ev) throw new NotFoundException('Event not found');
    const me = await this.attendeeOf(eventId, uid);
    if (!me) {
      throw new ForbiddenException('No encontramos tu registro en el evento');
    }
    return { ev, me };
  }

  async saveCard(eventId: string, uid: string, dto: SaveContactCardDto) {
    const { ev, me } = await this.requireMe(eventId, uid);
    const email = dto.email?.trim().toLowerCase() || undefined;
    const whatsapp = dto.whatsapp?.replace(/\D/g, '') || undefined;
    if (!email && !whatsapp) {
      throw new BadRequestException('Elige al menos un dato para compartir');
    }
    const card: ContactCard = {
      email,
      whatsapp,
      note: dto.note?.trim() || undefined,
      consentAt: new Date(),
      consentText: await this.consentText(ev.orgId),
    };
    await this.attendeeModel.updateOne(
      { _id: me },
      { $set: { contactCard: JSON.parse(JSON.stringify(card)) } },
    );
    return { ok: true };
  }

  /** Retira la autorización: borra la tarjeta y deja de compartir con todos */
  async deleteCard(eventId: string, uid: string) {
    const { ev, me } = await this.requireMe(eventId, uid);
    await Promise.all([
      this.attendeeModel.updateOne(
        { _id: me },
        { $set: { contactCard: null } },
      ),
      this.model.updateMany(
        { orgId: ev.orgId, a: me },
        { $set: { aShare: null } },
      ),
      this.model.updateMany(
        { orgId: ev.orgId, b: me },
        { $set: { bShare: null } },
      ),
    ]);
    return { ok: true };
  }

  // ── Acciones sobre un par ────────────────────────────────────────────────

  private async pairOf(eventId: string, uid: string, pairId: string) {
    const { ev, me } = await this.requireMe(eventId, uid);
    if (!Types.ObjectId.isValid(pairId)) {
      throw new NotFoundException('Contacto no encontrado');
    }
    const pair = await this.model
      .findOne({
        _id: pairId,
        orgId: ev.orgId,
        $or: [{ a: me }, { b: me }],
        blockedBy: null,
      })
      .lean();
    if (!pair) throw new NotFoundException('Contacto no encontrado');
    return { me, side: (pair.a === me ? 'a' : 'b') as Side, pair };
  }

  async share(eventId: string, uid: string, pairId: string) {
    const { me, side } = await this.pairOf(eventId, uid, pairId);
    const meDoc = await this.attendeeModel
      .findById(me, { contactCard: 1 })
      .lean();
    if (!meDoc?.contactCard) {
      throw new BadRequestException('Primero crea tu tarjeta de contacto');
    }
    await this.model.updateOne(
      { _id: pairId },
      {
        $set: {
          [`${side}Share`]: { at: new Date() },
          [`${side}DismissedAt`]: null,
        },
      },
    );
    return { ok: true };
  }

  async unshare(eventId: string, uid: string, pairId: string) {
    const { side } = await this.pairOf(eventId, uid, pairId);
    await this.model.updateOne(
      { _id: pairId },
      { $set: { [`${side}Share`]: null } },
    );
    return { ok: true };
  }

  async dismiss(eventId: string, uid: string, pairId: string) {
    const { side } = await this.pairOf(eventId, uid, pairId);
    await this.model.updateOne(
      { _id: pairId },
      { $set: { [`${side}DismissedAt`]: new Date() } },
    );
    return { ok: true };
  }

  /** Bloquear: el par desaparece para ambos y no vuelve a crearse */
  async block(eventId: string, uid: string, pairId: string) {
    const { me } = await this.pairOf(eventId, uid, pairId);
    await this.model.updateOne(
      { _id: pairId },
      { $set: { blockedBy: me, aShare: null, bShare: null } },
    );
    return { ok: true };
  }

  // ── Texto de autorización de la organización (dueñ@) ─────────────────────

  private async ownedOrg(slug: string, uid: string) {
    const org = await this.orgModel
      .findOne(
        { domainSlug: slug },
        { name: 1, ownerUid: 1, contactExchange: 1 },
      )
      .lean();
    if (!org) throw new NotFoundException('Organization not found');
    if (org.ownerUid !== uid) throw new ForbiddenException('Not owner');
    return org;
  }

  async getOrgConsent(slug: string, uid: string) {
    const org = await this.ownedOrg(slug, uid);
    const custom = org.contactExchange?.consentText?.trim() || '';
    return {
      consentText: custom,
      defaultText: defaultContactConsent(org.name),
    };
  }

  async updateOrgConsent(
    slug: string,
    uid: string,
    dto: UpdateContactConsentDto,
  ) {
    const org = await this.ownedOrg(slug, uid);
    await this.orgModel.updateOne(
      { _id: org._id },
      { $set: { 'contactExchange.consentText': dto.consentText.trim() } },
    );
    return this.getOrgConsent(slug, uid);
  }
}
