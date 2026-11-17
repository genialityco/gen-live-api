import { Types } from 'mongoose';
import { autoSendStep, selectNoShows } from './wa-audience';

describe('selectNoShows', () => {
  const a = new Types.ObjectId();
  const b = new Types.ObjectId();
  const c = new Types.ObjectId();
  const d = new Types.ObjectId();

  it('deja solo a los inscritos sin sesiones y sin marca de asistencia', () => {
    const eus = [
      { _id: 'eu1', attendeeId: a, status: 'registered' }, // no vio
      { _id: 'eu2', attendeeId: b, status: 'registered' }, // vio (sesión)
      { _id: 'eu3', attendeeId: c, status: 'attended' }, // marcado asistido
      { _id: 'eu4', attendeeId: d }, // sin estado, no vio
    ];
    const watched = [new Types.ObjectId(), 'eu2'];
    expect(selectNoShows(eus, watched)).toEqual([a, d]);
  });

  it('compara ids de sesiones como texto (ObjectId vs string)', () => {
    const id = new Types.ObjectId();
    const eus = [{ _id: id, attendeeId: a, status: 'registered' }];
    expect(selectNoShows(eus, [new Types.ObjectId(id.toHexString())])).toEqual(
      [],
    );
  });
});

describe('autoSendStep', () => {
  const now = new Date('2026-11-17T20:00:00Z');
  const min = (n: number) => new Date(now.getTime() + n * 60_000);
  const base = { delayMinutes: 30, dueAt: null, firedAt: null };

  it('espera mientras el evento no está en diferido', () => {
    expect(autoSendStep(base, 'live', now)).toEqual({ kind: 'wait' });
    expect(autoSendStep(base, 'ended', now)).toEqual({ kind: 'wait' });
  });

  it('fija la hora de envío al ver el evento en diferido', () => {
    expect(autoSendStep(base, 'replay', now)).toEqual({
      kind: 'schedule',
      dueAt: min(30),
    });
  });

  it('envía de inmediato si la espera es 0', () => {
    expect(autoSendStep({ ...base, delayMinutes: 0 }, 'replay', now)).toEqual({
      kind: 'fire',
    });
  });

  it('envía cuando llega la hora y espera antes', () => {
    expect(autoSendStep({ ...base, dueAt: min(5) }, 'replay', now)).toEqual({
      kind: 'wait',
    });
    expect(autoSendStep({ ...base, dueAt: min(-1) }, 'replay', now)).toEqual({
      kind: 'fire',
    });
  });

  it('cancela la hora si el evento sale de diferido antes de enviar', () => {
    expect(autoSendStep({ ...base, dueAt: min(5) }, 'ended', now)).toEqual({
      kind: 'unschedule',
    });
  });

  it('no vuelve a enviar una campaña ya disparada', () => {
    expect(
      autoSendStep(
        { ...base, dueAt: min(-1), firedAt: min(-1) },
        'replay',
        now,
      ),
    ).toEqual({ kind: 'wait' });
  });
});
