/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { VodMirrorService } from './vod-mirror.service';
import { EventsService } from './events.service';
import { VimeoService } from '../livekit/vimeo.service';

jest.mock('firebase-admin', () => ({
  database: { ServerValue: { TIMESTAMP: 'TS' } },
}));

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });

/** Modelo Mongo en memoria con lo justo que usa VodMirrorService. */
function fakeJobModel() {
  const jobs: any[] = [];
  let seq = 0;
  const matches = (doc: any, filter: any): boolean =>
    Object.entries(filter).every(([k, cond]: [string, any]) => {
      if (k === '$or') return cond.some((f: any) => matches(doc, f));
      const v = doc[k];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('$in' in cond) return cond.$in.includes(v);
        if ('$lte' in cond) return v != null && v <= cond.$lte;
        if ('$ne' in cond) return v !== cond.$ne;
      }
      if (cond === null) return v == null;
      return String(v) === String(cond);
    });
  const apply = (doc: any, update: any) => {
    Object.assign(doc, update.$set ?? {});
    for (const [k, n] of Object.entries(update.$inc ?? {}))
      doc[k] = Number(doc[k] ?? 0) + Number(n);
  };
  return {
    jobs,
    findOne: (f: any) => lean(jobs.find((j) => matches(j, f)) ?? null),
    find: (f: any) => {
      const res = jobs.filter((j) => matches(j, f));
      return { ...lean(res), sort: () => lean(res) };
    },
    create: (doc: any) => {
      const job = {
        _id: `job${++seq}`,
        sourceVideoId: '',
        detail: '',
        lastError: '',
        bunnyTitle: '',
        bunnyVideoId: '',
        bunnyUrl: '',
        applied: false,
        attempts: 0,
        phaseStartedAt: new Date(),
        nextRunAt: new Date(),
        lockedUntil: null,
        ...doc,
      };
      jobs.push(job);
      return Promise.resolve(job);
    },
    updateOne: (f: any, update: any) => {
      const doc = jobs.find((j) => matches(j, f));
      if (doc) apply(doc, update);
      return Promise.resolve();
    },
    findOneAndUpdate: (f: any, update: any) => {
      const doc = jobs.find((j) => matches(j, f));
      if (doc) apply(doc, update);
      return lean(doc ? { ...doc } : null);
    },
    updateMany: (f: any, update: any) => {
      jobs.filter((j) => matches(j, f)).forEach((j) => apply(j, update));
      return Promise.resolve();
    },
  };
}

function setup(
  cfg: any = { provider: 'vimeo', playbackHlsUrl: VIMEO_URL },
  event: any = {
    slug: 'mi-evento',
    status: 'replay',
    bunnyReplayConfig: { enabled: true },
  },
) {
  const jobModel = fakeJobModel();
  const eventModel = {
    event,
    findById: jest.fn(() => lean(eventModel.event)),
    findByIdAndUpdate: jest.fn((_id: string, update: any) => {
      eventModel.event = {
        ...eventModel.event,
        bunnyReplayConfig: {
          enabled: update.$set['bunnyReplayConfig.enabled'],
        },
      };
      return lean(eventModel.event);
    }),
  };
  const eventsService = {
    setDefaultReplaySource: jest.fn(() => Promise.resolve(true)),
  };
  const liveConfig = { getFresh: jest.fn(() => Promise.resolve(cfg)) };
  const vimeo = {
    enabled: true,
    getRecording: jest.fn(),
  };
  const bunny = {
    enabled: true,
    fetchFromUrl: jest.fn(() => Promise.resolve()),
    findByTitle: jest.fn(() => Promise.resolve(null)),
    getVideo: jest.fn(),
    getPlayback: jest.fn(),
  };
  const svc = new VodMirrorService(
    jobModel as any,
    eventModel,
    eventsService as any,
    liveConfig as any,
    vimeo as any,
    bunny as any,
  );
  /** Corre un ciclo con todos los trabajos vencidos. */
  const tick = async () => {
    for (const j of jobModel.jobs) j.nextRunAt = new Date(0);
    await (svc as any).tick();
  };
  return { svc, jobModel, eventModel, eventsService, vimeo, bunny, tick };
}

const VIMEO_URL = 'https://player.vimeo.com/video/123456';
const BUNNY_URL = 'https://vz-abc.b-cdn.net/guid-1/playlist.m3u8';

describe('VimeoService.parseRef', () => {
  it.each([
    ['https://player.vimeo.com/video/123456', 'video', '123456'],
    ['https://player.vimeo.com/video/123456?h=abc', 'video', '123456'],
    ['https://vimeo.com/123456', 'video', '123456'],
    ['https://vimeo.com/123456/abcdef1234', 'video', '123456'],
    ['https://vimeo.com/manage/videos/123456', 'video', '123456'],
    ['https://vimeo.com/event/987', 'event', '987'],
    ['https://vimeo.com/event/987/embed', 'event', '987'],
  ])('%s → %s %s', (url, kind, id) => {
    expect(VimeoService.parseRef(url)).toEqual({ kind, id });
  });

  it('no reconoce URLs que no son de Vimeo', () => {
    expect(VimeoService.parseRef('https://stream.mux.com/x.m3u8')).toBeNull();
    expect(VimeoService.parseRef('')).toBeNull();
  });
});

describe('VodMirrorService', () => {
  it('copia la grabación de Vimeo a Bunny y la deja como fuente por defecto', async () => {
    const { svc, jobModel, eventsService, vimeo, bunny, tick } = setup();
    vimeo.getRecording.mockResolvedValueOnce({
      state: 'pending',
      videoId: '123456',
      reason: 'archivando',
    });

    await svc.enqueue('ev1', 'mi-evento');
    expect(jobModel.jobs).toHaveLength(1);

    // 1. Vimeo aún archivando: sigue esperando.
    await tick();
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'waiting_source',
      detail: 'archivando',
      lockedUntil: null,
    });
    expect(bunny.fetchFromUrl).not.toHaveBeenCalled();

    // 2. Grabación lista: Bunny la importa con un título único.
    vimeo.getRecording.mockResolvedValueOnce({
      state: 'ready',
      videoId: '123456',
      downloadUrl: 'https://vimeo-cdn/file.mp4',
      name: 'Vivo',
      duration: 3600,
    });
    await tick();
    const title = jobModel.jobs[0].bunnyTitle;
    expect(title).toMatch(/^mi-evento-replay-job1-\d+$/);
    expect(bunny.fetchFromUrl).toHaveBeenCalledWith(
      'https://vimeo-cdn/file.mp4',
      title,
    );
    expect(jobModel.jobs[0].status).toBe('importing');

    // 3. Bunny creó el video: pasa a codificación.
    bunny.findByTitle.mockResolvedValueOnce({ guid: 'guid-1' } as any);
    await tick();
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'encoding',
      bunnyVideoId: 'guid-1',
    });

    // 4. Codificando: espera.
    bunny.getVideo.mockResolvedValueOnce({ status: 3, encodeProgress: 40 });
    await tick();
    expect(jobModel.jobs[0].status).toBe('encoding');
    expect(jobModel.jobs[0].detail).toContain('40%');

    // 5. Terminado: queda lista y se aplica al evento.
    bunny.getVideo.mockResolvedValueOnce({ status: 4, encodeProgress: 100 });
    bunny.getPlayback.mockResolvedValueOnce({
      playlistUrl: BUNNY_URL,
      tokenAuthEnabled: false,
    });
    await tick();
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'ready',
      bunnyUrl: BUNNY_URL,
      applied: true,
    });
    expect(eventsService.setDefaultReplaySource).toHaveBeenCalledWith(
      'ev1',
      'bunny',
      BUNNY_URL,
      [BUNNY_URL],
    );
  });

  it('está apagada por defecto: sin la opción activada no copia nada', async () => {
    const { svc, jobModel } = setup(undefined, {
      slug: 'mi-evento',
      status: 'replay',
    });
    await svc.enqueue('ev1', 'mi-evento');
    expect(jobModel.jobs).toHaveLength(0);
    await expect(svc.retry('ev1')).rejects.toThrow('desactivada');
    expect((await svc.getStatus('ev1')).enabled).toBe(false);
  });

  it('activarla con el evento ya en repetición arranca la copia', async () => {
    const { svc, jobModel } = setup(undefined, {
      slug: 'mi-evento',
      status: 'replay',
    });
    const ev = await svc.setEnabled('ev1', true);
    expect(ev.bunnyReplayConfig).toEqual({ enabled: true });
    expect(jobModel.jobs).toHaveLength(1);
    expect(jobModel.jobs[0].status).toBe('waiting_source');
  });

  it('activarla antes del vivo no crea nada hasta que termine', async () => {
    const { svc, jobModel } = setup(undefined, {
      slug: 'mi-evento',
      status: 'upcoming',
    });
    await svc.setEnabled('ev1', true);
    expect(jobModel.jobs).toHaveLength(0);
  });

  it('desactivarla detiene la copia en curso', async () => {
    const { svc, jobModel, bunny, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    Object.assign(jobModel.jobs[0], {
      status: 'encoding',
      bunnyVideoId: 'guid-1',
    });
    await svc.setEnabled('ev1', false);
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'failed',
      lastError: 'Desactivada en la configuración del evento.',
    });
    await tick();
    expect(bunny.getVideo).not.toHaveBeenCalled();
  });

  it('un trabajo pendiente no avanza si la opción se apagó', async () => {
    const { svc, jobModel, eventModel, vimeo, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    eventModel.event = { ...eventModel.event, bunnyReplayConfig: undefined };
    await tick();
    expect(vimeo.getRecording).not.toHaveBeenCalled();
    expect(jobModel.jobs[0].status).toBe('failed');
  });

  it('no hace nada si el estudio no usa Vimeo', async () => {
    const { svc, jobModel } = setup({
      provider: 'mux',
      playbackHlsUrl: 'https://stream.mux.com/x.m3u8',
    });
    await svc.enqueue('ev1', 'mi-evento');
    expect(jobModel.jobs).toHaveLength(0);
  });

  it('no repite la copia: si ya está lista, solo la vuelve a aplicar', async () => {
    const { svc, jobModel, eventsService, bunny } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    Object.assign(jobModel.jobs[0], { status: 'ready', bunnyUrl: BUNNY_URL });

    await svc.enqueue('ev1', 'mi-evento');
    expect(jobModel.jobs).toHaveLength(1);
    expect(bunny.fetchFromUrl).not.toHaveBeenCalled();
    expect(eventsService.setDefaultReplaySource).toHaveBeenCalledTimes(1);
  });

  it('si la respuesta de Bunny se perdió, reutiliza el video ya importado', async () => {
    const { svc, jobModel, vimeo, bunny, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    Object.assign(jobModel.jobs[0], { bunnyTitle: 'mi-evento-replay-job1-1' });
    vimeo.getRecording.mockResolvedValueOnce({
      state: 'ready',
      videoId: '123456',
      downloadUrl: 'https://vimeo-cdn/file.mp4',
    });
    bunny.findByTitle.mockResolvedValueOnce({ guid: 'guid-1' } as any);
    await tick();
    expect(bunny.fetchFromUrl).not.toHaveBeenCalled();
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'encoding',
      bunnyVideoId: 'guid-1',
    });
  });

  it('falla con un error de Vimeo definitivo y se puede reintentar', async () => {
    const { svc, jobModel, vimeo, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    vimeo.getRecording.mockResolvedValueOnce({
      state: 'error',
      videoId: '123456',
      reason: 'sin acceso',
    });
    await tick();
    expect(jobModel.jobs[0]).toMatchObject({
      status: 'failed',
      lastError: 'sin acceso',
    });

    vimeo.getRecording.mockResolvedValue({
      state: 'pending',
      videoId: '123456',
      reason: 'archivando',
    });
    const res = await svc.retry('ev1');
    expect(res.jobs[0].status).toBe('waiting_source');
    expect(res.jobs[0].lastError).toBeNull();
  });

  it('no usa Bunny si la librería exige URLs firmadas', async () => {
    const { svc, jobModel, eventsService, bunny, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    Object.assign(jobModel.jobs[0], {
      status: 'encoding',
      bunnyVideoId: 'guid-1',
    });
    bunny.getVideo.mockResolvedValueOnce({ status: 4, encodeProgress: 100 });
    bunny.getPlayback.mockResolvedValueOnce({
      playlistUrl: BUNNY_URL,
      tokenAuthEnabled: true,
    });
    await tick();
    expect(jobModel.jobs[0].status).toBe('failed');
    expect(eventsService.setDefaultReplaySource).not.toHaveBeenCalled();
  });

  it('se rinde cuando una fase supera su tiempo máximo', async () => {
    const { svc, jobModel, vimeo, tick } = setup();
    await svc.enqueue('ev1', 'mi-evento');
    jobModel.jobs[0].phaseStartedAt = new Date(Date.now() - 13 * 3600_000);
    vimeo.getRecording.mockResolvedValueOnce({
      state: 'pending',
      videoId: '123456',
      reason: 'archivando',
    });
    await tick();
    expect(jobModel.jobs[0].status).toBe('failed');
    expect(jobModel.jobs[0].lastError).toContain('Tiempo máximo');
  });
});

describe('EventsService.setDefaultReplaySource', () => {
  function setupEvents(ev: any) {
    let saved: any = null;
    const model = {
      findById: jest.fn(() => lean(ev)),
      findOneAndUpdate: jest.fn((_f: any, update: any) => {
        saved = update.$set;
        return lean({ ...ev, ...update.$set });
      }),
    };
    const svc = Object.create(EventsService.prototype);
    Object.assign(svc, {
      model,
      logger: { log: jest.fn(), warn: jest.fn() },
      mirrorEmergencyCache: jest.fn(() => Promise.resolve()),
    });
    return { svc: svc as EventsService, model, saved: () => saved };
  }

  it('pone Bunny primero y deja Vimeo como respaldo', async () => {
    const { svc, saved } = setupEvents({
      slug: 'mi-evento',
      status: 'replay',
      stream: { provider: 'vimeo', url: VIMEO_URL },
      streams: [{ provider: 'vimeo', url: VIMEO_URL }],
    });
    await expect(
      svc.setDefaultReplaySource('ev1', 'bunny', BUNNY_URL),
    ).resolves.toBe(true);
    expect(saved()).toEqual({
      streams: [
        { provider: 'bunny', url: BUNNY_URL },
        { provider: 'vimeo', url: VIMEO_URL },
      ],
      'stream.provider': 'bunny',
      'stream.url': BUNNY_URL,
    });
  });

  it('usa el stream legacy como respaldo si no hay streams', async () => {
    const { svc, saved } = setupEvents({
      slug: 'mi-evento',
      status: 'ended',
      stream: { provider: 'vimeo', url: VIMEO_URL },
      streams: [],
    });
    await svc.setDefaultReplaySource('ev1', 'bunny', BUNNY_URL);
    expect(saved().streams).toEqual([
      { provider: 'bunny', url: BUNNY_URL },
      { provider: 'vimeo', url: VIMEO_URL },
    ]);
  });

  it('reemplaza una copia automática anterior pero no una fuente manual', async () => {
    const old = 'https://vz-abc.b-cdn.net/old/playlist.m3u8';
    const ev = {
      slug: 'mi-evento',
      status: 'replay',
      streams: [
        { provider: 'vimeo', url: VIMEO_URL },
        { provider: 'bunny', url: old },
      ],
    };
    const auto = setupEvents(ev);
    await expect(
      auto.svc.setDefaultReplaySource('ev1', 'bunny', BUNNY_URL, [old]),
    ).resolves.toBe(true);
    expect(auto.saved().streams[0]).toEqual({
      provider: 'bunny',
      url: BUNNY_URL,
    });

    const manual = setupEvents(ev);
    await expect(
      manual.svc.setDefaultReplaySource('ev1', 'bunny', BUNNY_URL),
    ).resolves.toBe(false);
    expect(manual.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('no toca el evento mientras está en vivo', async () => {
    const { svc, model } = setupEvents({
      slug: 'mi-evento',
      status: 'live',
      streams: [{ provider: 'vimeo', url: VIMEO_URL }],
    });
    await expect(
      svc.setDefaultReplaySource('ev1', 'bunny', BUNNY_URL),
    ).resolves.toBe(false);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('EventsService.primaryReplaySource', () => {
  const streams = [
    { provider: 'vimeo', url: VIMEO_URL },
    { provider: 'bunny', url: BUNNY_URL },
  ];
  const stream = { provider: 'vimeo', url: VIMEO_URL };

  it('en repetición, Bunny es la principal si existe', () => {
    expect(
      EventsService.primaryReplaySource({ status: 'replay', stream, streams }),
    ).toEqual({ provider: 'bunny', url: BUNNY_URL });
    expect(
      EventsService.primaryReplaySource({ status: 'ended', stream, streams }),
    ).toEqual({ provider: 'bunny', url: BUNNY_URL });
  });

  it('en vivo sigue usando event.stream', () => {
    expect(
      EventsService.primaryReplaySource({ status: 'live', stream, streams }),
    ).toEqual(stream);
  });

  it('sin Bunny usa event.stream', () => {
    expect(
      EventsService.primaryReplaySource({
        status: 'replay',
        stream,
        streams: [streams[0]],
      }),
    ).toEqual(stream);
  });
});
