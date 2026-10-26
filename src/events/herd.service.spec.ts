/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { HerdService, herdKey } from './herd.service';

jest.mock('firebase-admin', () => ({
  database: { ServerValue: { TIMESTAMP: 'TS' } },
}));

const m = (ids: string[]) =>
  ids.map((id) => ({ uid: 'u' + id, attendeeId: id }));

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });

function setup(herdConfig: any) {
  const writes: Array<{ path: string; value: any }> = [];
  const attendees: Record<string, any> = {
    a1: { _id: 'a1', registrationData: { esp: 'endocrinologia' } },
    a2: { _id: 'a2', registrationData: { esp: 'Endocrinología' } }, // etiqueta, no valor
    a3: { _id: 'a3', registrationData: { esp: 'pediatria' } },
    a4: { _id: 'a4', registrationData: { esp: 'endocrinologia' } },
    a5: { _id: 'a5', registrationData: {} },
  };
  const eventModel = {
    findById: jest.fn((_id: string, proj?: any) =>
      lean(proj?.orgId ? { orgId: 'org1' } : { _id: 'ev1', herdConfig }),
    ),
  };
  const orgModel = {
    findById: jest.fn(() =>
      lean({
        registrationForm: {
          fields: [
            {
              id: 'esp',
              type: 'select',
              options: [
                { value: 'endocrinologia', label: 'Endocrinología' },
                { value: 'pediatria', label: 'Pediatría' },
              ],
            },
          ],
        },
      }),
    ),
  };
  const orgAttendeeModel = {
    collection: { name: 'orgattendees' },
    find: jest.fn((q: any) =>
      lean(q._id.$in.map((id: string) => attendees[id]).filter(Boolean)),
    ),
  };
  const stored: Record<string, any> = {};
  const rtdb = {
    ref: (path: string) => ({
      once: () => Promise.resolve({ val: () => stored[path] ?? null }),
      set: (value: any) => {
        writes.push({ path, value });
        return Promise.resolve();
      },
      update: (value: any) => {
        writes.push({ path, value });
        return Promise.resolve();
      },
      remove: () => Promise.resolve(),
    }),
  };
  // Simula la agregación: inscritos agrupados por el valor crudo del campo
  const eventUserModel = {
    aggregate: jest.fn(() => {
      const byRaw = new Map<unknown, number>();
      for (const a of Object.values(attendees)) {
        const raw = a.registrationData.esp;
        byRaw.set(raw, (byRaw.get(raw) ?? 0) + 1);
      }
      return Promise.resolve([...byRaw].map(([_id, n]) => ({ _id, n })));
    }),
  };
  const svc = new HerdService(
    eventModel as any,
    orgModel as any,
    orgAttendeeModel as any,
    rtdb as any,
    eventUserModel as any,
  );
  return { svc, writes, orgAttendeeModel, attendees, stored, eventUserModel };
}

const baseConfig = {
  enabled: true,
  fieldId: 'esp',
  groupLabels: [{ value: 'endocrinologia', label: 'endocrinólogos' }],
  publicMessage: { enabled: true, minIntervalSec: 20, milestoneEvery: 1 },
};

describe('HerdService', () => {
  afterEach(() => jest.useRealTimers());

  it('agrupa por opción canonizando valor y etiqueta', async () => {
    const { svc, writes } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a3', 'a5']));

    const live = writes.find((w) => w.path === '/herd/ev1/live');
    expect(live?.value.counts).toEqual({ endocrinologia: 2, pediatria: 1 });
    expect(live?.value.total).toBe(4);
    // El primer flush es línea base: no anuncia
    expect(writes.some((w) => w.path === '/herd/ev1/public')).toBe(false);
  });

  it('anuncia al crecer un grupo, respeta el intervalo y no repite tras recargas', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, writes, orgAttendeeModel } = setup(baseConfig);
    const publics = () => writes.filter((w) => w.path === '/herd/ev1/public');

    await svc.onActiveAttendees('ev1', m(['a1']));
    await svc.onActiveAttendees('ev1', m(['a1', 'a2']));
    expect(publics()).toHaveLength(1);
    expect(publics()[0].value).toMatchObject({
      key: 'endocrinologia',
      label: 'endocrinólogos',
      count: 2,
    });

    // Dentro del intervalo: queda pendiente
    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a4']));
    expect(publics()).toHaveLength(1);

    jest.setSystemTime(1_000_000 + 21_000);
    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a4']));
    expect(publics()).toHaveLength(2);
    expect(publics()[1].value.count).toBe(3);

    // Alguien recarga (sale y vuelve): no supera la marca de agua → no anuncia
    jest.setSystemTime(1_000_000 + 60_000);
    await svc.onActiveAttendees('ev1', m(['a1', 'a2']));
    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a4']));
    expect(publics()).toHaveLength(2);

    // Se cachea el grupo; solo se relee a quien entra o vuelve a entrar (a4)
    const queried = orgAttendeeModel.find.mock.calls.flatMap(
      (c: any[]) => c[0]._id.$in,
    );
    expect(queried).toEqual(['a1', 'a2', 'a4', 'a4']);
  });

  it('con hitos solo anuncia al cruzar múltiplos', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, writes } = setup({
      ...baseConfig,
      publicMessage: { enabled: true, minIntervalSec: 5, milestoneEvery: 2 },
    });
    await svc.onActiveAttendees('ev1', m(['a3']));
    await svc.onActiveAttendees('ev1', m(['a3', 'a1'])); // endocrino: 0 → 1
    expect(writes.some((w) => w.path === '/herd/ev1/public')).toBe(false);
    jest.setSystemTime(1_000_000 + 10_000);
    await svc.onActiveAttendees('ev1', m(['a3', 'a1', 'a2'])); // 1 → 2
    const pub = writes.filter((w) => w.path === '/herd/ev1/public');
    expect(pub).toHaveLength(1);
    expect(pub[0].value.count).toBe(2);
  });

  it('publica el grupo propio de cada asistente solo al llegar', async () => {
    const { svc, writes } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1', 'a5']));
    await svc.onActiveAttendees('ev1', m(['a1', 'a3']));
    const members = writes.filter((w) => w.path === '/herd/ev1/members');
    expect(members.map((w) => w.value)).toEqual([
      // a5 no tiene grupo: null borra un grupo viejo si lo hubiera
      {
        ua1: {
          key: 'endocrinologia',
          label: 'endocrinólogos',
          singular: 'endocrinólogo',
          position: 1,
        },
        ua5: null,
      },
      {
        ua3: {
          key: 'pediatria',
          label: 'Pediatría',
          singular: 'Pediatría',
          position: 1,
        },
      },
    ]);
  });

  it('relee el grupo cuando el asistente vuelve a entrar tras actualizar su registro', async () => {
    const { svc, writes, attendees } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1', 'a3']));
    // a3 sale, cambia su especialidad a endocrinología y vuelve
    await svc.onActiveAttendees('ev1', m(['a1']));
    attendees.a3.registrationData.esp = 'endocrinologia';
    await svc.onActiveAttendees('ev1', m(['a1', 'a3']));

    const members = writes.filter((w) => w.path === '/herd/ev1/members');
    expect(members.at(-1)?.value).toEqual({
      ua3: {
        key: 'endocrinologia',
        label: 'endocrinólogos',
        singular: 'endocrinólogo',
        position: 2,
      },
    });
    const live = writes.filter((w) => w.path === '/herd/ev1/live');
    expect(live.at(-1)?.value.counts).toEqual({ endocrinologia: 2 });
  });

  it('anuncia a mano el grupo indicado o el más grande, aunque el automático esté apagado', async () => {
    const { svc, writes } = setup({
      ...baseConfig,
      publicMessage: { enabled: false },
    });
    await expect(svc.announceNow('ev1', 'public')).rejects.toThrow();

    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a3']));
    await svc.announceNow('ev1', 'public');
    await svc.announceNow('ev1', 'public', 'pediatria', 'Bienvenidos {grupo}');
    await expect(
      svc.announceNow('ev1', 'public', 'cardiologia'),
    ).rejects.toThrow();

    const pub = writes.filter((w) => w.path === '/herd/ev1/public');
    expect(pub.map((w) => w.value)).toMatchObject([
      {
        key: 'endocrinologia',
        label: 'endocrinólogos',
        count: 2,
        manual: true,
      },
      { key: 'pediatria', count: 1, text: 'Bienvenidos {grupo}' },
    ]);
  });

  it('el privado manual dispara el aviso para todos o para un grupo', async () => {
    const { svc, writes } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1', 'a2', 'a3']));
    const all = await svc.announceNow('ev1', 'private');
    const one = await svc.announceNow(
      'ev1',
      'private',
      'pediatria',
      'Hola {nombre}',
    );
    expect(all.count).toBe(3);
    expect(one.count).toBe(1);
    const trig = writes.filter((w) => w.path === '/herd/ev1/privateTrigger');
    expect(trig.map((w) => w.value)).toMatchObject([
      { key: null },
      { key: 'pediatria', text: 'Hola {nombre}' },
    ]);
  });

  it('numera la llegada por grupo, la mantiene al volver y la retoma tras reiniciar', async () => {
    const { svc, writes } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1']));
    await svc.onActiveAttendees('ev1', m(['a1', 'a3', 'a2']));
    // a1 sale y vuelve: conserva su puesto
    await svc.onActiveAttendees('ev1', m(['a3', 'a2']));
    await svc.onActiveAttendees('ev1', m(['a3', 'a2', 'a1']));

    const arrivals = writes.filter((w) => w.path === '/herd/ev1/arrivals');
    expect(arrivals.map((w) => w.value)).toEqual([
      { 'endocrinologia/a1': 1 },
      { 'pediatria/a3': 1, 'endocrinologia/a2': 2 },
    ]);

    // Otro proceso arranca con lo persistido: a4 es el tercero, no el primero
    const fresh = setup(baseConfig);
    fresh.stored['/herd/ev1/arrivals'] = { endocrinologia: { a1: 1, a2: 2 } };
    await fresh.svc.onActiveAttendees('ev1', m(['a4']));
    const members = fresh.writes.find((w) => w.path === '/herd/ev1/members');
    expect(members?.value.ua4).toMatchObject({
      key: 'endocrinologia',
      position: 3,
    });
  });

  it('repite el público cada repeatEverySec con el conteo actual, rotando grupos', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, writes } = setup({
      ...baseConfig,
      publicMessage: { enabled: true, minIntervalSec: 20, repeatEverySec: 60 },
    });
    const publics = () => writes.filter((w) => w.path === '/herd/ev1/public');
    const all = m(['a1', 'a2', 'a3']);

    await svc.onActiveAttendees('ev1', all); // línea base
    jest.setSystemTime(1_000_000 + 30_000);
    await svc.onActiveAttendees('ev1', all);
    expect(publics()).toHaveLength(0);

    jest.setSystemTime(1_000_000 + 61_000);
    await svc.onActiveAttendees('ev1', all);
    jest.setSystemTime(1_000_000 + 122_000);
    await svc.onActiveAttendees('ev1', all);
    expect(publics().map((w) => w.value)).toMatchObject([
      { key: 'endocrinologia', count: 2, repeat: true },
      { key: 'pediatria', count: 1, repeat: true },
    ]);
  });

  it('cuenta los inscritos por grupo y los publica con los conteos y el anuncio', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { svc, writes, eventUserModel } = setup(baseConfig);
    await svc.onActiveAttendees('ev1', m(['a1']));
    await svc.onActiveAttendees('ev1', m(['a1', 'a2']));

    const live = writes.filter((w) => w.path === '/herd/ev1/live').at(-1);
    // a1, a2 (por etiqueta) y a4 son endocrinología; a5 no tiene grupo pero cuenta en el total
    expect(live?.value).toMatchObject({
      registered: { endocrinologia: 3, pediatria: 1 },
      registeredTotal: 5,
    });
    const pub = writes.find((w) => w.path === '/herd/ev1/public');
    expect(pub?.value).toMatchObject({
      count: 2,
      registered: 3,
      registeredTotal: 5,
    });
    // Dentro del TTL no se vuelve a consultar
    expect(eventUserModel.aggregate).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + 61_000);
    await svc.onActiveAttendees('ev1', m(['a1', 'a2']));
    expect(eventUserModel.aggregate).toHaveBeenCalledTimes(2);
  });

  it('no hace nada si está desactivado', async () => {
    const { svc, writes } = setup({ ...baseConfig, enabled: false });
    await svc.onActiveAttendees('ev1', m(['a1']));
    expect(writes).toHaveLength(0);
  });

  it('herdKey produce claves válidas para RTDB', () => {
    expect(herdKey(' Médico.Gen#eral [x] ')).toBe('medico_gen_eral _x_');
  });
});
