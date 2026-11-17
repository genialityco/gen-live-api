/**
 * Audiencia y disparo automático de campañas de WhatsApp.
 *
 * Funciones puras (sin Mongo) para poder probarlas: quién entra en la
 * audiencia de un evento y qué hacer en cada revisión con una campaña
 * programada para enviarse cuando el evento pasa a diferido (grabación).
 */
import { Types } from 'mongoose';

/**
 * - org_attendees: todos los asistentes de la organización con teléfono
 *   (comportamiento original).
 * - event_registered: inscritos a este evento.
 * - event_no_show: inscritos a este evento que no lo vieron (ni en vivo ni
 *   en la grabación).
 */
export const WA_AUDIENCES = [
  'org_attendees',
  'event_registered',
  'event_no_show',
] as const;
export type WaAudience = (typeof WA_AUDIENCES)[number];

// Máximo de espera configurable tras pasar a diferido: 7 días
export const MAX_AUTO_SEND_DELAY_MIN = 7 * 24 * 60;

// Revisión periódica de campañas programadas
export const AUTO_SEND_TICK_MS = 60_000;

export interface EventUserLite {
  _id: unknown;
  attendeeId: Types.ObjectId;
  status?: string;
}

/**
 * Inscritos que no vieron el evento: no marcados como `attended` y sin
 * ninguna sesión de visualización en vivo ni en diferido.
 *
 * Se excluye también a quien ya entró a la grabación, porque la invitación
 * a verla ya no le sirve.
 */
export function selectNoShows(
  eventUsers: EventUserLite[],
  watchedEventUserIds: Iterable<unknown>,
): Types.ObjectId[] {
  const watched = new Set([...watchedEventUserIds].map(String));
  return eventUsers
    .filter((u) => u.status !== 'attended' && !watched.has(String(u._id)))
    .map((u) => u.attendeeId);
}

export interface AutoSendState {
  delayMinutes: number;
  dueAt: Date | null;
  firedAt: Date | null;
}

export type AutoSendStep =
  | { kind: 'wait' }
  | { kind: 'schedule'; dueAt: Date }
  | { kind: 'unschedule' }
  | { kind: 'fire' };

/**
 * Qué hacer en una revisión con una campaña programada.
 *
 * - El evento no está en diferido: no se envía; si ya tenía hora de envío
 *   (pasó a diferido y volvió atrás) se borra, y se vuelve a contar desde
 *   que pase otra vez a diferido.
 * - Primera vez que se ve en diferido: se fija la hora de envío
 *   (ahora + espera).
 * - Llegó la hora: se envía.
 */
export function autoSendStep(
  state: AutoSendState,
  eventStatus: string | undefined,
  now: Date,
): AutoSendStep {
  if (state.firedAt) return { kind: 'wait' };
  if (eventStatus !== 'replay') {
    return state.dueAt ? { kind: 'unschedule' } : { kind: 'wait' };
  }
  if (!state.dueAt) {
    const dueAt = new Date(now.getTime() + state.delayMinutes * 60_000);
    return dueAt <= now ? { kind: 'fire' } : { kind: 'schedule', dueAt };
  }
  return now >= state.dueAt ? { kind: 'fire' } : { kind: 'wait' };
}
