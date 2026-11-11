/**
 * Ventana real del vivo (inicio y cierre de la transmisión) y cálculo de
 * "se quedó hasta el final".
 *
 * `endedAt` solo se escribe cuando alguien marca el evento como `ended`, que
 * puede pasar horas después del vivo (o nunca, si pasa directo a `replay`).
 * Por eso se guardan aparte `liveStartedAt` / `liveEndedAt` al entrar y salir
 * de `live`, y para los eventos anteriores a esos campos se estima el cierre
 * a partir de cuándo se fue la audiencia.
 */

export type EventStatus = 'upcoming' | 'live' | 'ended' | 'replay';

// Margen para contar que alguien "se quedó hasta el final"
export const UNTIL_END_MARGIN_MS = 5 * 60_000;

// Ventana en la que se busca la salida masiva del final del vivo
const EXODUS_WINDOW_MS = 5 * 60_000;

// Si la salida masiva queda este tiempo (o más) antes de `endedAt`, se asume
// que el evento se marcó como terminado tarde y se usa la estimación
const LATE_END_TOLERANCE_MS = 15 * 60_000;

/**
 * Campos de la ventana del vivo a escribir al cambiar de estado.
 * - Entrar en `live` desde `upcoming` (o sin inicio guardado): nuevo inicio.
 * - Volver a `live` desde `ended`/`replay` (se cortó por error): mismo
 *   inicio; el cierre anterior se borra porque el vivo sigue.
 * - Salir de `live`: cierre del vivo.
 */
export function liveWindowUpdate(
  prev: { status?: string; liveStartedAt?: Date | null },
  next: EventStatus,
  now: Date,
): {
  liveStartedAt?: Date;
  liveEndedAt?: Date;
  $unset?: { liveEndedAt: 1 };
} {
  const wasLive = prev.status === 'live';
  if (next === 'live') {
    if (wasLive) return {};
    const fresh = prev.status === 'upcoming' || !prev.liveStartedAt;
    return {
      ...(fresh ? { liveStartedAt: now } : {}),
      $unset: { liveEndedAt: 1 },
    };
  }
  return wasLive ? { liveEndedAt: now } : {};
}

/**
 * Estima el cierre del vivo como el final de la ventana de 5 minutos con más
 * salidas (última señal de cada espectador), buscándola en la segunda mitad
 * de las salidas. null si no hay una salida masiva clara.
 */
export function estimateLiveEnd(lastSeens: number[]): number | null {
  const xs = lastSeens.filter((t) => t > 0).sort((a, b) => a - b);
  if (xs.length < 10) return null;
  const minCount = Math.max(5, Math.ceil(xs.length * 0.05));
  const from = Math.floor(xs.length / 2);
  let best: number | null = null;
  let bestCount = 0;
  let lo = 0;
  for (let i = 0; i < xs.length; i++) {
    while (xs[i] - xs[lo] > EXODUS_WINDOW_MS) lo++;
    const count = i - lo + 1;
    // A igual cantidad gana la más tardía (el cierre, no una caída intermedia)
    if (i >= from && count >= bestCount) {
      bestCount = count;
      best = xs[i];
    }
  }
  return bestCount >= minCount ? best : null;
}

export type LiveEndSource = 'recorded' | 'estimated' | 'status';

/**
 * Cierre del vivo a usar para "se quedó hasta el final":
 * - recorded: `liveEndedAt` guardado al salir de `live`.
 * - status: `endedAt` (marcado como terminado), si es coherente con la
 *   salida de la audiencia.
 * - estimated: salida masiva de la audiencia, cuando no hay `liveEndedAt` y
 *   `endedAt` falta o quedó muy tarde.
 * Mientras el evento sigue en vivo no hay cierre.
 */
export function resolveLiveEnd(
  event: {
    status?: string;
    liveEndedAt?: Date | string | null;
    endedAt?: Date | string | null;
  },
  lastSeens: number[],
): { at: number | null; source: LiveEndSource | null } {
  if (event.liveEndedAt) {
    return { at: new Date(event.liveEndedAt).getTime(), source: 'recorded' };
  }
  if (event.status === 'live') return { at: null, source: null };
  const estimated = estimateLiveEnd(lastSeens);
  const endedAt = event.endedAt ? new Date(event.endedAt).getTime() : null;
  if (endedAt !== null) {
    if (estimated !== null && estimated < endedAt - LATE_END_TOLERANCE_MS) {
      return { at: estimated, source: 'estimated' };
    }
    return { at: endedAt, source: 'status' };
  }
  return estimated !== null
    ? { at: estimated, source: 'estimated' }
    : { at: null, source: null };
}

/** ¿Su última señal fue a menos de 5 minutos del cierre (o después)? */
export function stayedUntilEnd(lastSeen: number, liveEnd: number | null) {
  return liveEnd !== null && lastSeen >= liveEnd - UNTIL_END_MARGIN_MS;
}
