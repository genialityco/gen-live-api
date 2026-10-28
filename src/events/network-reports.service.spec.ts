/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NetworkReportsService, ipPrefix } from './network-reports.service';

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });

function setup(docs: any[] = []) {
  const reportModel = {
    updateOne: jest.fn(() => Promise.resolve({})),
    find: jest.fn(() => ({ sort: () => lean(docs) })),
  };
  const eventUserModel = {
    findOne: jest.fn(() => lean({ attendeeId: 'att1' })),
  };
  const orgAttendeeModel = {
    find: jest.fn(() =>
      lean([{ _id: 'att1', name: 'Ana', email: 'ana@rama.gov.co' }]),
    ),
  };
  const geoip = {
    lookupCountry: jest.fn(() => ({ iso: 'CO' })),
    lookupAsn: jest.fn(() => ({ asn: 27951, org: 'Rama Judicial' })),
  };
  const svc = new NetworkReportsService(
    reportModel as any,
    eventUserModel as any,
    orgAttendeeModel as any,
    geoip as any,
  );
  return { svc, reportModel };
}

describe('NetworkReportsService', () => {
  it('ipPrefix guarda solo la red, no la IP', () => {
    expect(ipPrefix('190.25.12.77')).toBe('190.25.12.0/24');
    expect(ipPrefix('::ffff:181.49.1.1')).toBe('181.49.1.0/24');
    expect(ipPrefix('2800:e2:3f00:1:2::5')).toBe('2800:e2:3f00::/48');
    expect(ipPrefix('no-es-ip')).toBeUndefined();
  });

  it('guarda el bloqueo con red, país y asistente, y suma ocurrencias', async () => {
    const { svc, reportModel } = setup();
    await svc.report(
      'ev1',
      'u1',
      {
        videoHost: 'player.vimeo.com',
        cause: 'all_blocked',
        probes: [{ host: 'player.vimeo.com', result: 'blocked', ms: 40 }],
      },
      '190.25.12.77',
      'Chrome',
    );
    const [filter, update, opts] = reportModel.updateOne.mock
      .calls[0] as unknown as [any, any, any];
    expect(filter).toEqual({
      eventId: 'ev1',
      uid: 'u1',
      videoHost: 'player.vimeo.com',
    });
    expect(update.$set).toMatchObject({
      cause: 'all_blocked',
      ipPrefix: '190.25.12.0/24',
      country: 'CO',
      asn: 27951,
      asnOrg: 'Rama Judicial',
      attendeeId: 'att1',
      recovered: false,
    });
    expect(update.$inc).toEqual({ occurrences: 1 });
    expect(opts).toEqual({ upsert: true });
  });

  it('marca como recuperado sin crear un reporte nuevo', async () => {
    const { svc, reportModel } = setup();
    await svc.report(
      'ev1',
      'u1',
      { videoHost: 'player.vimeo.com', recovered: true },
      '1.2.3.4',
      '',
    );
    const [, update, opts] = reportModel.updateOne.mock.calls[0] as unknown as [
      any,
      any,
      any,
    ];
    expect(update.$set.recovered).toBe(true);
    expect(opts).toBeUndefined();
  });

  it('resume por causa, red y servidor de video', async () => {
    const base = {
      eventId: 'ev1',
      videoHost: 'player.vimeo.com',
      asn: 27951,
      asnOrg: 'Rama Judicial',
      country: 'CO',
      occurrences: 1,
      lastSeenAt: new Date(),
    };
    const { svc } = setup([
      {
        ...base,
        uid: 'u1',
        attendeeId: 'att1',
        cause: 'all_blocked',
        ipPrefix: '190.25.12.0/24',
        recovered: true,
      },
      {
        ...base,
        uid: 'u2',
        cause: 'all_blocked',
        ipPrefix: '190.25.13.0/24',
        recovered: false,
      },
      {
        ...base,
        uid: 'u3',
        cause: 'video_blocked',
        asnOrg: 'Claro',
        asn: 10620,
        recovered: false,
      },
    ]);
    const s = await svc.summary('ev1');
    expect(s.total).toBe(3);
    expect(s.recovered).toBe(1);
    expect(s.byCause).toEqual({ all_blocked: 2, video_blocked: 1 });
    expect(s.byOrg[0]).toEqual({
      org: 'Rama Judicial (AS27951)',
      n: 2,
      prefixes: ['190.25.12.0/24', '190.25.13.0/24'],
    });
    expect(s.byHost).toEqual([{ host: 'player.vimeo.com', n: 3 }]);
    expect(s.recent[0]).toMatchObject({
      name: 'Ana',
      email: 'ana@rama.gov.co',
    });
  });
});
