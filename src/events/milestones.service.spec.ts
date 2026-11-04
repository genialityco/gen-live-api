/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  joinMilestoneNames,
  milestoneHoldout,
  MilestonesService,
  renderMilestoneTemplate,
} from './milestones.service';

jest.mock('firebase-admin', () => ({
  database: { ServerValue: { TIMESTAMP: 'TS' } },
}));

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });
const A1 = '64a000000000000000000001';
const A2 = '64a000000000000000000002';

function setup(milestonesConfig: any, status = 'live') {
  const writes: Array<{ path: string; value: any; op: string }> = [];
  const awards: any[] = [];
  let pushId = 0;
  const rtdb = {
    ref: (path: string) => ({
      once: () => Promise.resolve({ val: () => null }),
      set: (value: any) => {
        writes.push({ path, value, op: 'set' });
        return Promise.resolve();
      },
      update: (value: any) => {
        writes.push({ path, value, op: 'update' });
        return Promise.resolve();
      },
      push: () => ({ key: `k${++pushId}` }),
    }),
  };
  const eventModel = {
    findById: jest.fn(() => lean({ milestonesConfig, status })),
  };
  const awardModel = {
    find: jest.fn(() => lean(awards)),
    insertMany: jest.fn((rows: any[]) => {
      awards.push(...rows);
      return Promise.resolve(rows);
    }),
    updateMany: jest.fn(() => Promise.resolve()),
  };
  const orgAttendeeModel = {
    find: jest.fn(() =>
      lean([
        { _id: A1, name: 'Ana María Pérez' },
        { _id: A2, name: 'Carlos Ruiz' },
      ]),
    ),
  };
  const pollModel = { countDocuments: jest.fn(() => Promise.resolve(2)) };
  const greetingModel = { countDocuments: jest.fn(() => Promise.resolve(1)) };
  const herd = {
    formalTitles: jest.fn(() => Promise.resolve(new Map([[A1, 'Dr(a).']]))),
  };
  // Historial en Mongo: A2 ya llevaba 50 min y llegó antes que A1
  const viewingSessionModel = {
    aggregate: jest.fn(() =>
      Promise.resolve([
        { _id: 'eu1', live: 600, first: new Date(500_000) },
        { _id: 'eu2', live: 3000, first: new Date(100_000) },
      ]),
    ),
  };
  const eventUserModel = {
    find: jest.fn(() =>
      lean([
        { _id: 'eu1', attendeeId: A1 },
        { _id: 'eu2', attendeeId: A2 },
      ]),
    ),
    // Eventos anteriores a los que asistió cada uno: A1 2, A2 ninguno
    aggregate: jest.fn(() => Promise.resolve([{ _id: A1, n: 2 }])),
  };
  const svc = new MilestonesService(
    eventModel as any,
    awardModel as any,
    orgAttendeeModel as any,
    pollModel as any,
    greetingModel as any,
    rtdb as any,
    herd as any,
    viewingSessionModel as any,
    eventUserModel as any,
  );
  return {
    svc,
    writes,
    awards,
    awardModel,
    pollModel,
    viewingSessionModel,
    eventUserModel,
  };
}

const watch40 = {
  enabled: true,
  publicMessage: { minIntervalSec: 30, maxNames: 3 },
  items: [{ id: 'w40', type: 'watchMinutes', threshold: 40, delivery: 'both' }],
};

/** Latidos de presencia cada 30 s entre `from` y `to` (inclusive) */
async function beat(
  svc: MilestonesService,
  members: Array<{ uid: string; attendeeId: string }>,
  from: number,
  to: number,
) {
  for (let t = from; t <= to; t += 30_000) {
    jest.setSystemTime(t);
    await svc.onPresence('ev1', members, true);
  }
}

const privates = (writes: any[]) =>
  writes.filter((w) => w.path === '/milestones/ev1/private');
const publics = (writes: any[]) =>
  writes.filter((w) => w.path === '/milestones/ev1/public');

describe('MilestonesService', () => {
  afterEach(() => jest.useRealTimers());

  it('felicita en privado y en público al cumplir los minutos seguidos, una sola vez', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, writes, awards } = setup(watch40);
    const both = [
      { uid: 'u1', attendeeId: A1 },
      { uid: 'u2', attendeeId: A2 },
    ];
    await beat(svc, both, 1_000_000, 1_000_000 + 39.5 * 60_000);
    expect(awards).toHaveLength(0);

    jest.setSystemTime(1_000_000 + 40 * 60_000);
    await svc.onPresence('ev1', both, true);
    expect(awards.map((a) => a.attendeeId).sort()).toEqual([A1, A2]);
    const priv = privates(writes);
    expect(priv).toHaveLength(1);
    expect(Object.values(priv[0].value).map((v: any) => v.text)).toEqual([
      '¡Dr(a). Ana, llevas 40 minutos seguidos con nosotros! Gracias por acompañarnos',
      '¡Carlos, llevas 40 minutos seguidos con nosotros! Gracias por acompañarnos',
    ]);

    // El público agrupa a quienes lo cumplieron juntos
    await jest.runOnlyPendingTimersAsync();
    expect(publics(writes)).toHaveLength(1);
    expect(publics(writes)[0].value).toMatchObject({
      milestoneId: 'w40',
      count: 2,
      text: '¡Felicitamos a Dr(a). Ana y Carlos por 40 minutos seguidos con nosotros!',
    });

    // Siguen conectados: no se repite
    jest.setSystemTime(1_000_000 + 41 * 60_000);
    await svc.onPresence('ev1', both, true);
    expect(awards).toHaveLength(2);
    expect(privates(writes)).toHaveLength(1);
  });

  it('un corte de más de 90 s reinicia la racha; uno corto no', async () => {
    jest.useFakeTimers({ now: 0 });
    const { svc, awards } = setup({
      ...watch40,
      items: [
        { id: 'w2', type: 'watchMinutes', threshold: 2, delivery: 'private' },
      ],
    });
    const me = [{ uid: 'u1', attendeeId: A1 }];
    await beat(svc, me, 0, 60_000);
    // Vuelve 140 s después del último latido: racha nueva desde 200 s
    await beat(svc, me, 200_000, 290_000);
    expect(awards).toHaveLength(0); // 90 s de racha (sin el corte serían 290 s)
    // Corte de 60 s (recarga): la racha sigue y llega a 150 s
    jest.setSystemTime(350_000);
    await svc.onPresence('ev1', me, true);
    expect(awards).toMatchObject([{ milestoneId: 'w2', value: 2 }]);
  });

  it('fuera del vivo no cuenta minutos', async () => {
    jest.useFakeTimers({ now: 0 });
    const { svc, awards } = setup(watch40);
    const me = [{ uid: 'u1', attendeeId: A1 }];
    await svc.onPresence('ev1', me, false);
    jest.setSystemTime(60 * 60_000);
    await svc.onPresence('ev1', me, false);
    await svc.onPresence('ev1', me, true);
    expect(awards).toHaveLength(0);
  });

  it('encuestas: otorga por cantidad respondida y por estar entre los primeros', async () => {
    const { svc, writes, awards } = setup({
      enabled: true,
      items: [
        { id: 'p2', type: 'pollsAnswered', threshold: 2, delivery: 'private' },
        { id: 'p3', type: 'pollsAnswered', threshold: 3, delivery: 'private' },
        { id: 'first', type: 'pollFirst', threshold: 5, delivery: 'public' },
      ],
    });
    await svc.onPollResponse('ev1', A1, 'u1', 4);
    expect(awards.map((a) => a.milestoneId).sort()).toEqual(['first', 'p2']);
    // Solo "público": sin felicitación privada para "first"
    const texts = Object.values(privates(writes)[0].value).map(
      (v: any) => v.milestoneId,
    );
    expect(texts).toEqual(['p2']);
    svc.clearEvent('ev1');
  });

  it('con el evento fuera del vivo no otorga logros de encuestas ni saludos', async () => {
    const { svc, awards } = setup(
      {
        enabled: true,
        items: [
          {
            id: 'p1',
            type: 'pollsAnswered',
            threshold: 1,
            delivery: 'private',
          },
          {
            id: 'g1',
            type: 'greetingsSent',
            threshold: 1,
            delivery: 'private',
          },
        ],
      },
      'ended',
    );
    await svc.onPollResponse('ev1', A1, 'u1', 1);
    await svc.onGreetingSent('ev1', A1, 'u1');
    expect(awards).toHaveLength(0);
  });

  it('el grupo de control queda registrado pero no recibe felicitaciones', async () => {
    // Asistentes que caen en control con 50 %
    const ids = Array.from({ length: 40 }, (_, i) =>
      (0x64a000000000000000000000n + BigInt(i)).toString(16),
    );
    const control = ids.find((id) => milestoneHoldout('ev1', id, 50))!;
    const { svc, writes, awards } = setup({
      enabled: true,
      holdoutPercent: 50,
      items: [
        { id: 'g1', type: 'greetingsSent', threshold: 1, delivery: 'both' },
      ],
    });
    await svc.onGreetingSent('ev1', control, 'u9');
    expect(awards).toMatchObject([{ attendeeId: control, holdout: true }]);
    expect(privates(writes)).toHaveLength(0);
    svc.clearEvent('ev1');
  });

  it('desactivado o sin hitos activos no hace nada', async () => {
    jest.useFakeTimers({ now: 0 });
    const { svc, awards } = setup({ ...watch40, enabled: false });
    const me = [{ uid: 'u1', attendeeId: A1 }];
    await svc.onPresence('ev1', me, true);
    jest.setSystemTime(90 * 60_000);
    await svc.onPresence('ev1', me, true);
    expect(awards).toHaveLength(0);
  });

  it('minutos totales: suma lo que ya había en Mongo más lo contado en vivo', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, awards } = setup({
      enabled: true,
      items: [
        { id: 't51', type: 'totalMinutes', threshold: 51, delivery: 'private' },
      ],
    });
    const both = [
      { uid: 'u1', attendeeId: A1 },
      { uid: 'u2', attendeeId: A2 },
    ];
    await beat(svc, both, 1_000_000, 1_000_000 + 30_000);
    expect(awards).toHaveLength(0); // A2: 50,5 min
    await beat(svc, both, 1_000_000 + 60_000, 1_000_000 + 90_000);
    expect(awards).toMatchObject([{ attendeeId: A2, value: 51 }]);
  });

  it('primeros en conectarse: por la primera conexión, felicitado al estar en vivo', async () => {
    const { svc, awards } = setup({
      enabled: true,
      items: [
        { id: 'f1', type: 'firstToConnect', threshold: 1, delivery: 'private' },
      ],
    });
    await svc.onPresence('ev1', [{ uid: 'u1', attendeeId: A1 }], true);
    expect(awards).toHaveLength(0); // el primero (A2) no está conectado
    await svc.onPresence(
      'ev1',
      [
        { uid: 'u1', attendeeId: A1 },
        { uid: 'u2', attendeeId: A2 },
      ],
      true,
    );
    expect(awards).toMatchObject([{ attendeeId: A2, value: 1 }]);
  });

  it('asistente frecuente: cuenta los eventos anteriores más este', async () => {
    const { svc, writes, awards, eventUserModel } = setup({
      enabled: true,
      items: [
        {
          id: 'fr3',
          type: 'frequentAttendee',
          threshold: 3,
          delivery: 'private',
        },
      ],
    });
    const both = [
      { uid: 'u1', attendeeId: A1 },
      { uid: 'u2', attendeeId: A2 },
    ];
    await svc.onPresence('ev1', both, true);
    await svc.onPresence('ev1', both, true);
    expect(awards).toMatchObject([{ attendeeId: A1, value: 3 }]);
    expect(Object.values(privates(writes)[0].value)[0]).toMatchObject({
      text: '¡Dr(a). Ana, este es tu evento número 3 con nosotros! Gracias por tu fidelidad',
    });
    // Se consulta una sola vez por asistente
    expect(eventUserModel.aggregate).toHaveBeenCalledTimes(1);
  });

  it('logro manual: felicita a los conectados elegidos, una vez, solo en vivo', async () => {
    const cfg = {
      enabled: true,
      items: [
        {
          id: 'mvp',
          type: 'manual',
          threshold: 1,
          delivery: 'private',
          privateTemplate: '¡{nombre}, mejor pregunta de la noche!',
        },
      ],
    };
    const { svc, writes, awards } = setup(cfg);
    await svc.onPresence('ev1', [{ uid: 'u1', attendeeId: A1 }], true);
    await expect(svc.awardManual('ev1', 'mvp', [A1])).resolves.toEqual({
      awarded: 1,
      already: 0,
    });
    expect(Object.values(privates(writes)[0].value)[0]).toMatchObject({
      text: '¡Dr(a). Ana, mejor pregunta de la noche!',
    });
    await expect(svc.awardManual('ev1', 'mvp', [A1])).resolves.toEqual({
      awarded: 0,
      already: 1,
    });
    expect(awards).toHaveLength(1);
    await expect(svc.awardManual('ev1', 'otro', [A1])).rejects.toThrow();

    const ended = setup(cfg, 'ended');
    await expect(ended.svc.awardManual('ev1', 'mvp', [A1])).rejects.toThrow(
      /en vivo/,
    );
  });

  it('plantillas y lista de nombres', () => {
    expect(
      renderMilestoneTemplate(
        '{nombres} {fue|fueron} de los primeros {umbral}',
        {
          nombres: 'Ana',
          cantidad: 1,
          umbral: 5,
        },
      ),
    ).toBe('Ana fue de los primeros 5');
    expect(
      renderMilestoneTemplate('{nombres} {fue|fueron}', {
        nombres: 'Ana y Luis',
        cantidad: 2,
        umbral: 5,
      }),
    ).toBe('Ana y Luis fueron');
    expect(joinMilestoneNames(['Ana', 'Luis', 'Sara'])).toBe(
      'Ana, Luis y Sara',
    );
    expect(joinMilestoneNames(['Ana', 'Luis', 'Sara', 'Iván', 'Eva'], 2)).toBe(
      'Ana, Luis y 3 colegas más',
    );
  });
});
