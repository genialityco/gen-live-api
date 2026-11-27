/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { ContactExchangeService } from './contact-exchange.service';

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });
const leanSorted = (v: unknown) => ({
  sort: () => ({ limit: () => lean(v) }),
});

const EV = '64e000000000000000000001';
const ORG = '64f000000000000000000001';
const ME = '64a000000000000000000001';
const ANA = '64a000000000000000000002';

const card = (email: string) => ({
  email,
  whatsapp: '573001112233',
  consentAt: new Date(),
  consentText: 'ok',
});

function setup(opts: {
  enabled?: boolean;
  pair?: any;
  myCard?: any;
  anaCard?: any;
  myAttendee?: string | null;
}) {
  const updates: any[] = [];
  const model = {
    find: jest.fn(() => leanSorted(opts.pair ? [opts.pair] : [])),
    findOne: jest.fn(() => lean(opts.pair ?? null)),
    updateOne: jest.fn((...args: any[]) => {
      updates.push(args);
      return Promise.resolve({});
    }),
    updateMany: jest.fn(() => Promise.resolve({})),
  };
  const eventModel = {
    findById: jest.fn(() =>
      lean({
        orgId: ORG,
        herdConfig: {
          enabled: true,
          greeting: { enabled: true, contactExchange: opts.enabled ?? true },
        },
      }),
    ),
  };
  const eventUserModel = {
    findOne: jest.fn(() =>
      lean(
        opts.myAttendee === null ? null : { attendeeId: opts.myAttendee ?? ME },
      ),
    ),
  };
  const attendeeModel = {
    find: jest.fn(() =>
      lean([
        {
          _id: ME,
          name: 'Juan Pérez',
          email: 'juan@x.co',
          phone: '57300',
          contactCard: opts.myCard ?? null,
        },
        {
          _id: ANA,
          name: 'Ana María Gómez',
          email: 'ana@x.co',
          contactCard: opts.anaCard ?? null,
        },
      ]),
    ),
    findById: jest.fn(() => lean({ contactCard: opts.myCard ?? null })),
    updateOne: jest.fn(() => Promise.resolve({})),
  };
  const orgModel = {
    findById: jest.fn(() => lean({ name: 'Endocrinocampus' })),
  };
  const herd = {
    formalTitles: jest.fn(() => Promise.resolve(new Map([[ANA, 'Dr(a).']]))),
  };
  const svc = new ContactExchangeService(
    model as any,
    eventModel as any,
    eventUserModel as any,
    attendeeModel as any,
    orgModel as any,
    herd as any,
  );
  return { svc, model, updates, attendeeModel };
}

const basePair = (extra: any = {}) => ({
  _id: '650000000000000000000001',
  orgId: ORG,
  a: ME,
  b: ANA,
  events: [EV],
  groupLabel: 'Endocrinología',
  aShare: null,
  bShare: null,
  aDismissedAt: null,
  bDismissedAt: null,
  blockedBy: null,
  ...extra,
});

describe('ContactExchangeService', () => {
  it('crea el par al devolver un saludo, ordenado y por organización', async () => {
    const { svc, model } = setup({});
    await svc.onGreetingReply(EV, ANA, ME, 'Endocrinología');
    expect(model.updateOne).toHaveBeenCalledWith(
      { orgId: ORG, a: ME, b: ANA },
      {
        $addToSet: { events: EV },
        $set: { groupLabel: 'Endocrinología' },
      },
      { upsert: true },
    );
  });

  it('no crea pares si el evento no tiene el intercambio activo', async () => {
    const { svc, model } = setup({ enabled: false });
    await svc.onGreetingReply(EV, ANA, ME);
    await svc.onGreetingReply(EV, ME, ME); // consigo mismo, tampoco
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('pendiente: solo primer nombre, sin datos de contacto', async () => {
    const { svc } = setup({ pair: basePair(), anaCard: card('ana@x.co') });
    const r = await svc.mine(EV, 'uid');
    expect(r.pairs[0]).toMatchObject({
      status: 'pending',
      name: 'Dr(a). Ana',
      contact: null,
      inEvent: true,
    });
  });

  it('si solo uno aceptó, nadie ve los datos del otro', async () => {
    const { svc } = setup({
      pair: basePair({ aShare: { at: new Date() } }),
      myCard: card('juan@x.co'),
      anaCard: card('ana@x.co'),
    });
    const r = await svc.mine(EV, 'uid');
    expect(r.pairs[0]).toMatchObject({ status: 'waiting', contact: null });
  });

  it('mutuo: nombre completo y la tarjeta del otro', async () => {
    const { svc } = setup({
      pair: basePair({
        aShare: { at: new Date() },
        bShare: { at: new Date() },
      }),
      myCard: card('juan@x.co'),
      anaCard: card('ana@x.co'),
    });
    const r = await svc.mine(EV, 'uid');
    expect(r.pairs[0]).toMatchObject({
      status: 'mutual',
      name: 'Dr(a). Ana María Gómez',
      contact: { email: 'ana@x.co', whatsapp: '573001112233' },
    });
  });

  it('si el otro retiró su tarjeta, deja de verse aunque hubiera aceptado', async () => {
    const { svc } = setup({
      pair: basePair({
        aShare: { at: new Date() },
        bShare: { at: new Date() },
      }),
      myCard: card('juan@x.co'),
      anaCard: null,
    });
    const r = await svc.mine(EV, 'uid');
    expect(r.pairs[0]).toMatchObject({ status: 'waiting', contact: null });
  });

  it('no deja compartir sin tarjeta de contacto', async () => {
    const { svc } = setup({ pair: basePair(), myCard: null });
    await expect(svc.share(EV, 'uid', basePair()._id)).rejects.toThrow(
      'Primero crea tu tarjeta',
    );
  });

  it('exige al menos un dato en la tarjeta', async () => {
    const { svc } = setup({});
    await expect(
      svc.saveCard(EV, 'uid', { consent: true } as any),
    ).rejects.toThrow('al menos un dato');
  });
});
