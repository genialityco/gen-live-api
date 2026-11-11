import {
  estimateLiveEnd,
  liveWindowUpdate,
  resolveLiveEnd,
  stayedUntilEnd,
} from './live-window';

const MIN = 60_000;
const now = new Date('2026-11-04T00:00:00Z');

describe('liveWindowUpdate', () => {
  it('upcoming → live: nuevo inicio y borra el cierre', () => {
    expect(liveWindowUpdate({ status: 'upcoming' }, 'live', now)).toEqual({
      liveStartedAt: now,
      $unset: { liveEndedAt: 1 },
    });
  });

  it('ended → live (se cortó por error): conserva el inicio', () => {
    const start = new Date('2026-11-03T23:00:00Z');
    expect(
      liveWindowUpdate({ status: 'ended', liveStartedAt: start }, 'live', now),
    ).toEqual({ $unset: { liveEndedAt: 1 } });
  });

  it('replay → live sin inicio guardado: nuevo inicio', () => {
    expect(liveWindowUpdate({ status: 'replay' }, 'live', now)).toEqual({
      liveStartedAt: now,
      $unset: { liveEndedAt: 1 },
    });
  });

  it('live → replay o ended: registra el cierre', () => {
    expect(liveWindowUpdate({ status: 'live' }, 'replay', now)).toEqual({
      liveEndedAt: now,
    });
    expect(liveWindowUpdate({ status: 'live' }, 'ended', now)).toEqual({
      liveEndedAt: now,
    });
  });

  it('sin pasar por live no toca nada', () => {
    expect(liveWindowUpdate({ status: 'live' }, 'live', now)).toEqual({});
    expect(liveWindowUpdate({ status: 'replay' }, 'ended', now)).toEqual({});
  });
});

/** Audiencia: salidas repartidas durante 60 min y salida masiva al final */
function audience(end: number) {
  const out: number[] = [];
  for (let i = 0; i < 40; i++) out.push(end - 60 * MIN + i * 1.5 * MIN);
  for (let i = 0; i < 30; i++) out.push(end - 3 * MIN + (i % 6) * 30_000);
  return out;
}

describe('estimateLiveEnd', () => {
  it('encuentra la salida masiva del final', () => {
    const end = now.getTime();
    const est = estimateLiveEnd(audience(end));
    expect(est).not.toBeNull();
    expect(Math.abs(est! - end)).toBeLessThanOrEqual(3 * MIN);
  });

  it('sin datos suficientes no estima', () => {
    expect(estimateLiveEnd([1, 2, 3])).toBeNull();
  });
});

describe('resolveLiveEnd', () => {
  const end = now.getTime();

  it('usa el cierre registrado si existe', () => {
    expect(
      resolveLiveEnd({ liveEndedAt: now, endedAt: new Date(end + 1e7) }, []),
    ).toEqual({ at: end, source: 'recorded' });
  });

  it('endedAt marcado horas después: usa la estimación', () => {
    const r = resolveLiveEnd(
      { status: 'ended', endedAt: new Date(end + 3 * 60 * MIN) },
      audience(end),
    );
    expect(r.source).toBe('estimated');
    expect(Math.abs(r.at! - end)).toBeLessThanOrEqual(3 * MIN);
  });

  it('endedAt coherente con la salida: lo respeta', () => {
    const r = resolveLiveEnd(
      { status: 'ended', endedAt: new Date(end + 2 * MIN) },
      audience(end),
    );
    expect(r).toEqual({ at: end + 2 * MIN, source: 'status' });
  });

  it('en vivo no hay cierre', () => {
    expect(resolveLiveEnd({ status: 'live' }, audience(end))).toEqual({
      at: null,
      source: null,
    });
  });
});

describe('stayedUntilEnd', () => {
  it('cuenta hasta 5 minutos antes del cierre', () => {
    expect(stayedUntilEnd(now.getTime() - 4 * MIN, now.getTime())).toBe(true);
    expect(stayedUntilEnd(now.getTime() - 6 * MIN, now.getTime())).toBe(false);
    expect(stayedUntilEnd(now.getTime(), null)).toBe(false);
  });
});
