/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as admin from 'firebase-admin';
import { Event, EventDocument } from './schemas/event.schema';
import { EventUser } from './schemas/event-user.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';
import { ViewingSession } from './schemas/viewing-session.schema';
import { HerdGreeting } from './schemas/herd-greeting.schema';
import { RtdbService } from '../rtdb/rtdb.service';
import {
  DEFAULT_HERD_CONFIG,
  greetingHasButton,
  HerdService,
  welchPValue,
} from './herd.service';
import { HerdGreetingActionDto } from './dtos/herd-greeting-action.dto';

/** Lo que el backend publicó del asistente en /herd/{eventId}/members/{uid} */
type MemberEntry = {
  key: string;
  label: string;
  singular?: string;
  muted?: boolean;
  greet?: boolean;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Primer nombre, sin caracteres raros y corto (se pinta sobre el video) */
const firstName = (s: unknown) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 24) ?? '';

/**
 * Saludo entre colegas de los anuncios de manada: el asistente toca
 * «👋 Saludar» en su anuncio individual y los demás conectados de su grupo
 * ven «👋 Ana te saluda desde …», con opción de devolverlo.
 *
 * Todo pasa por aquí (no se escribe RTDB desde el navegador): se valida el
 * grupo publicado por el backend, el botón del experimento y la espera
 * entre saludos, y cada acción queda en herd_greetings para medir.
 *
 * RTDB:
 * - /herd/{eventId}/greetings/{groupKey}/{greetingId} = { fromUid, name, at }
 * - /herd/{eventId}/greetReplies/{toUid}/{id} = { fromUid, name, greetingId, at }
 */
@Injectable()
export class HerdGreetingService {
  private readonly logger = new Logger(HerdGreetingService.name);

  constructor(
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(EventUser.name) private eventUserModel: Model<EventUser>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    @InjectModel(HerdGreeting.name)
    private greetingModel: Model<HerdGreeting>,
    @InjectModel(ViewingSession.name)
    private viewingSessionModel: Model<ViewingSession>,
    private rtdb: RtdbService,
    private herd: HerdService,
  ) {}

  private async greetingConfig(eventId: string) {
    const ev = await this.eventModel
      .findById(eventId, { status: 1, herdConfig: 1 })
      .lean();
    if (!ev) throw new NotFoundException('Event not found');
    return {
      status: ev.status,
      herdEnabled: !!ev.herdConfig?.enabled,
      greeting: {
        ...DEFAULT_HERD_CONFIG.greeting,
        ...(ev.herdConfig?.greeting ?? {}),
      },
    };
  }

  private async member(eventId: string, uid: string) {
    const snap = await this.rtdb
      .ref(`/herd/${eventId}/members/${uid}`)
      .once('value');
    return (snap.val() as MemberEntry | null) ?? null;
  }

  /** Asistente (OrgAttendee) y su primer nombre a partir del UID de la sesión */
  private async who(eventId: string, uid: string, fallbackName?: string) {
    const eu = await this.eventUserModel
      .findOne({ eventId, firebaseUID: uid }, { attendeeId: 1 })
      .lean();
    const attendeeId = eu?.attendeeId ? String(eu.attendeeId) : undefined;
    let name = '';
    if (attendeeId) {
      const a = await this.orgAttendeeModel
        .findById(attendeeId, { name: 1 })
        .lean();
      name = firstName(a?.name);
    }
    return { attendeeId, name: name || firstName(fallbackName) || 'Un colega' };
  }

  async act(eventId: string, uid: string, dto: HerdGreetingActionDto) {
    const cfg = await this.greetingConfig(eventId);
    if (!cfg.herdEnabled || !cfg.greeting.enabled) {
      throw new ForbiddenException('El saludo entre colegas está apagado');
    }
    if (cfg.status !== 'live') {
      throw new BadRequestException(
        'El saludo solo funciona con el evento en vivo',
      );
    }
    const member = await this.member(eventId, uid);
    if (!member?.key || member.muted) {
      throw new ForbiddenException('No perteneces a un grupo con anuncios');
    }

    if (dto.action === 'impression')
      return this.impression(eventId, uid, member, dto);
    if (dto.action === 'greet')
      return this.greet(
        eventId,
        uid,
        member,
        dto,
        cfg.greeting.cooldownSec ?? 60,
      );
    return this.reply(eventId, uid, member, dto);
  }

  private async impression(
    eventId: string,
    uid: string,
    member: MemberEntry,
    dto: HerdGreetingActionDto,
  ) {
    const { attendeeId } = await this.who(eventId, uid, dto.name);
    await this.greetingModel.create({
      eventId,
      kind: 'impression',
      uid,
      attendeeId,
      groupKey: member.key,
      groupLabel: member.label,
      source: dto.source,
      hasButton: !!member.greet,
    });
    return { ok: true, hasButton: !!member.greet };
  }

  private async greet(
    eventId: string,
    uid: string,
    member: MemberEntry,
    dto: HerdGreetingActionDto,
    cooldownSec: number,
  ) {
    if (!member.greet) {
      throw new ForbiddenException(
        'Este asistente no tiene el botón de saludo',
      );
    }
    const last = await this.greetingModel
      .findOne({ eventId, kind: 'greet', uid }, { createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean();
    const waitMs = last?.createdAt
      ? new Date(last.createdAt).getTime() + cooldownSec * 1000 - Date.now()
      : 0;
    if (waitMs > 0) {
      throw new BadRequestException({
        message: 'Ya saludaste hace un momento',
        retryInSec: Math.ceil(waitMs / 1000),
      });
    }

    const { attendeeId, name } = await this.who(eventId, uid, dto.name);
    const live = await this.rtdb
      .ref(`/herd/${eventId}/live/counts/${member.key}`)
      .once('value');
    const recipients = Math.max(0, Number(live.val() ?? 0) - 1);

    const ref = this.rtdb
      .ref(`/herd/${eventId}/greetings/${member.key}`)
      .push();
    await ref.set({
      fromUid: uid,
      name,
      at: admin.database.ServerValue.TIMESTAMP,
    });
    await this.greetingModel.create({
      eventId,
      kind: 'greet',
      uid,
      attendeeId,
      groupKey: member.key,
      groupLabel: member.label,
      source: dto.source,
      recipients,
      greetingId: ref.key,
    });
    return { ok: true, greetingId: ref.key, recipients, name };
  }

  private async reply(
    eventId: string,
    uid: string,
    member: MemberEntry,
    dto: HerdGreetingActionDto,
  ) {
    if (!dto.greetingId) throw new BadRequestException('greetingId requerido');
    // Quien quedó sin botón (experimento) tampoco puede devolver: así su
    // brazo no tiene ninguna interacción del saludo
    if (!member.greet) {
      throw new ForbiddenException('Este asistente no tiene el botón de saludo');
    }
    const original = await this.greetingModel
      .findOne({ eventId, kind: 'greet', greetingId: dto.greetingId })
      .lean();
    if (!original) throw new NotFoundException('Saludo no encontrado');
    if (original.uid === uid)
      throw new BadRequestException('Es tu propio saludo');
    if (original.groupKey !== member.key) {
      throw new ForbiddenException('El saludo es de otro grupo');
    }

    const { attendeeId, name } = await this.who(eventId, uid, dto.name);
    try {
      await this.greetingModel.create({
        eventId,
        kind: 'reply',
        uid,
        attendeeId,
        groupKey: member.key,
        groupLabel: member.label,
        greetingId: dto.greetingId,
        toUid: original.uid,
      });
    } catch (e: any) {
      if (e?.code === 11000)
        throw new BadRequestException('Ya devolviste este saludo');
      throw e;
    }
    await this.rtdb.ref(`/herd/${eventId}/greetReplies/${original.uid}`).push({
      fromUid: uid,
      name,
      greetingId: dto.greetingId,
      at: admin.database.ServerValue.TIMESTAMP,
    });
    return { ok: true };
  }

  // ── Informe ──────────────────────────────────────────────────────────────

  async report(eventId: string) {
    const cfg = await this.greetingConfig(eventId);
    const docs = await this.greetingModel
      .find(
        { eventId },
        {
          kind: 1,
          uid: 1,
          attendeeId: 1,
          groupKey: 1,
          groupLabel: 1,
          hasButton: 1,
          recipients: 1,
          greetingId: 1,
          source: 1,
        },
      )
      .lean();

    const impressions = docs.filter((d) => d.kind === 'impression');
    const greets = docs.filter((d) => d.kind === 'greet');
    const replies = docs.filter((d) => d.kind === 'reply');
    const uniq = <T>(xs: T[]) => new Set(xs).size;

    const shownWithButton = new Set(
      impressions.filter((d) => d.hasButton).map((d) => d.uid),
    );
    const senders = new Set(greets.map((d) => d.uid));
    const repliedGreetings = new Set(replies.map((d) => d.greetingId));
    const recipients = greets.reduce((s, d) => s + (d.recipients ?? 0), 0);

    // Por grupo
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        shown: Set<string>;
        senders: Set<string>;
        greets: number;
        recipients: number;
        replies: number;
      }
    >();
    const g = (key: string, label?: string) => {
      const row = groups.get(key) ?? {
        key,
        label: label ?? key,
        shown: new Set(),
        senders: new Set(),
        greets: 0,
        recipients: 0,
        replies: 0,
      };
      if (label) row.label = label;
      groups.set(key, row);
      return row;
    };
    for (const d of impressions)
      if (d.hasButton) g(d.groupKey, d.groupLabel).shown.add(d.uid);
    for (const d of greets) {
      const row = g(d.groupKey, d.groupLabel);
      row.senders.add(d.uid);
      row.greets++;
      row.recipients += d.recipients ?? 0;
    }
    for (const d of replies) g(d.groupKey, d.groupLabel).replies++;

    const bySource: Record<string, { shown: number; greets: number }> = {};
    for (const d of impressions)
      if (d.hasButton) {
        const s = (bySource[d.source ?? 'welcome'] ??= { shown: 0, greets: 0 });
        s.shown++;
      }
    for (const d of greets) {
      const s = (bySource[d.source ?? 'welcome'] ??= { shown: 0, greets: 0 });
      s.greets++;
    }

    return {
      enabled: cfg.greeting.enabled,
      holdoutPercent: cfg.greeting.holdoutPercent ?? 0,
      impressions: {
        total: impressions.length,
        attendees: uniq(impressions.map((d) => d.uid)),
        withButton: shownWithButton.size,
      },
      greets: {
        total: greets.length,
        senders: senders.size,
        recipients,
        // De quienes vieron el botón, cuántos saludaron al menos una vez
        ctrPct: shownWithButton.size
          ? round1(
              ([...senders].filter((u) => shownWithButton.has(u)).length /
                shownWithButton.size) *
                100,
            )
          : null,
      },
      replies: {
        total: replies.length,
        repliers: uniq(replies.map((d) => d.uid)),
        // Saludos que recibieron al menos una devolución
        greetsWithReplyPct: greets.length
          ? round1((repliedGreetings.size / greets.length) * 100)
          : null,
      },
      byGroup: [...groups.values()]
        .map((r) => ({
          key: r.key,
          label: r.label,
          shown: r.shown.size,
          senders: r.senders.size,
          greets: r.greets,
          recipients: r.recipients,
          replies: r.replies,
          ctrPct: r.shown.size
            ? round1(
                ([...r.senders].filter((u) => r.shown.has(u)).length /
                  r.shown.size) *
                  100,
              )
            : null,
        }))
        .sort((a, b) => b.greets - a.greets || b.shown - a.shown),
      bySource,
      experiment: await this.experiment(
        eventId,
        cfg.greeting.holdoutPercent ?? 0,
      ),
    };
  }

  /**
   * Permanencia con botón vs. sin botón, entre quienes ven los anuncios
   * (brazo de tratamiento de la manada, grupo no excluido) y estuvieron en vivo.
   */
  private async experiment(eventId: string, holdoutPercent: number) {
    if (holdoutPercent <= 0) return null;
    const ctx = await this.herd.contextFor(eventId);
    if (!ctx) return null;

    const attendeeIds = [...ctx.arms.entries()]
      .filter(([, arm]) => arm === 't')
      .map(([id]) => id);
    if (!attendeeIds.length) return null;

    // Grupo actual (para dejar fuera los excluidos)
    const groupOf = new Map<string, string | null>();
    if (ctx.fieldId) {
      const path = `registrationData.${ctx.fieldId}`;
      const docs = await this.orgAttendeeModel
        .find({ _id: { $in: attendeeIds } }, { [path]: 1 })
        .lean();
      for (const d of docs as any[]) {
        groupOf.set(
          String(d._id),
          ctx.resolve(d.registrationData?.[ctx.fieldId])?.key ?? null,
        );
      }
    }

    const eventUsers = await this.eventUserModel
      .find({ eventId }, { _id: 1, attendeeId: 1 })
      .lean();
    const attendeeByEu = new Map(
      eventUsers.map((eu) => [String(eu._id), String(eu.attendeeId)]),
    );
    const rows: Array<{ _id: unknown; playback: number; wasLive: boolean }> =
      await this.viewingSessionModel.aggregate([
        { $match: { eventId } },
        {
          $group: {
            _id: '$eventUserId',
            playback: { $sum: '$playbackTotalSeconds' },
            wasLive: { $max: '$wasLiveDuringSession' },
          },
        },
      ]);
    const viewing = new Map<string, { playback: number; wasLive: boolean }>();
    for (const r of rows) {
      const aid = attendeeByEu.get(String(r._id));
      if (aid) viewing.set(aid, r);
    }

    const withButton: number[] = [];
    const withoutButton: number[] = [];
    for (const aid of attendeeIds) {
      const key = groupOf.get(aid);
      if (!key || ctx.excludedKeys.has(key)) continue;
      const v = viewing.get(aid);
      if (!v?.wasLive) continue;
      (greetingHasButton(eventId, aid, holdoutPercent)
        ? withButton
        : withoutButton
      ).push((v.playback ?? 0) / 60);
    }

    const summarize = (xs: number[]) => ({
      attendees: xs.length,
      avgPlaybackMin: round1(mean(xs)),
      medianPlaybackMin: round1(median(xs)),
      watched30Pct: xs.length
        ? round1((xs.filter((x) => x >= 30).length / xs.length) * 100)
        : 0,
    });
    const diff = mean(withButton) - mean(withoutButton);
    return {
      withButton: summarize(withButton),
      withoutButton: summarize(withoutButton),
      lift: {
        playbackMin: round1(diff),
        playbackPct:
          mean(withoutButton) > 0
            ? round1((diff / mean(withoutButton)) * 100)
            : null,
        pValue: welchPValue(withButton, withoutButton),
      },
    };
  }
}
