import { Logger } from '@nestjs/common';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { SongExecutionEngine } from './song-execution.engine';

// A renamed radio program keeps its engine: the telemetry client moves to the new id in one step and a Take is
// possible there as soon as Palazzo answers, with no switching radio off and on.

type FakeClient = {
  programId: string;
  start: jest.Mock;
  stop: jest.Mock;
  snapshot: () => void;
};
type MockOptions = {
  programId: unknown;
  callbacks: { onStatus(programId: string, status: object): void };
};
const mockClients: FakeClient[] = [];

jest.mock('./palazzo-program.client', () => ({
  PalazzoProgramClient: jest.fn().mockImplementation((options: MockOptions) => {
    const status = {
      programId: options.programId as string,
      connection: 'connected',
      lastSnapshotAt: null as string | null,
      lastEventAt: null,
      degraded: false,
    };
    const client = {
      programId: status.programId,
      start: jest.fn(),
      stop: jest.fn(),
      getStatus: () => status,
      snapshot: () => {
        status.lastSnapshotAt = '2026-11-26T00:00:00.000Z';
        options.callbacks.onStatus(status.programId, status);
      },
    };
    mockClients.push(client as unknown as FakeClient);
    return client;
  }),
}));

const stored = {
  palazzoUrl: 'http://palazzo:3100',
  programState: {
    programId: 'night',
    type: 'radio',
    songSequence: null,
    songQueue: null,
    songRotation: null,
  },
};

async function build(setting: typeof stored | null) {
  mockClients.length = 0;
  const prisma = {
    radioSettings: {
      findMany: jest.fn().mockResolvedValue([
        {
          ...stored,
          programState: { ...stored.programState, programId: 'demo' },
        },
      ]),
      findFirst: jest.fn().mockResolvedValue(setting),
    },
  };
  const metrics = new Proxy({}, { get: () => jest.fn() });
  const publisher = new Proxy({}, { get: () => () => Promise.resolve() });
  const engine = new SongExecutionEngine(
    {} as never,
    {} as never,
    prisma as never,
    publisher as never,
    metrics as never,
  );
  const telemetry = new PalazzoRadioTelemetryService(
    prisma as never,
    engine,
    metrics as never,
    { validateBaseUrl: (url: string) => url } as never,
    { reset: jest.fn() } as never,
  );
  await engine.onModuleInit();
  await telemetry.onModuleInit();
  engine.onModuleDestroy();
  return { engine, telemetry, prisma };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('renaming a radio program', () => {
  it('moves telemetry to the new id with the old client stopped first, and the engine is reconciled there', async () => {
    const { engine, telemetry } = await build(stored);
    mockClients[0].snapshot();
    expect(telemetry.isReconciled('demo')).toBe(true);

    await engine.renameProgram('demo', 'night');

    const [old, next] = mockClients;
    expect(mockClients).toHaveLength(2);
    expect(next.programId).toBe('night');
    expect(old.stop.mock.invocationCallOrder[0]).toBeLessThan(
      next.start.mock.invocationCallOrder[0],
    );
    expect(telemetry.getStatus('demo')).toBeNull();
    expect(telemetry.getStatus('night')).not.toBeNull();
    // Take is possible as soon as Palazzo's snapshot arrives for the new id.
    next.snapshot();
    expect(telemetry.isReconciled('night')).toBe(true);
    expect(engine.getOnAirView('night').frozen).toBe(false);
  });

  it('starts nothing for a program whose radio is off', async () => {
    const { engine, telemetry } = await build(null);
    await engine.renameProgram('demo', 'night');
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].stop).toHaveBeenCalled();
    expect(telemetry.getStatus('night')).toBeNull();
  });

  it('starts nothing for a program that is not a radio, or has no engine address', async () => {
    for (const setting of [
      { ...stored, programState: { ...stored.programState, type: 'tv' } },
      { ...stored, palazzoUrl: '' },
    ]) {
      const { engine } = await build(setting);
      await engine.renameProgram('demo', 'night');
      expect(mockClients).toHaveLength(1);
    }
  });

  it('takes up a stored autoplay sequence under the new id', async () => {
    const { engine } = await build({
      ...stored,
      programState: {
        ...stored.programState,
        songSequence: {
          mode: 'autoplay',
          items: [
            {
              id: 'a',
              kind: 'preset',
              title: 'One',
              artist: 'A',
              audioUrl: 'https://media.example/1.mp3',
              coverUrl: '',
            },
          ],
          activeItemId: 'a',
          startedAt: 1,
          loop: true,
        },
      } as never,
    });
    // A play of the old id leaves with it.
    engine.handleManualSong('demo', 'https://media.example/1.mp3');
    await engine.renameProgram('demo', 'night');
    engine.onModuleDestroy();
    expect(engine.getOnAirView('night').mode).toBe('autoplay');
    expect(engine.getOnAirView('demo').mode).toBeNull();
  });

  it('drops what a deleted program left under the new id: its engine state and its client', async () => {
    const { engine, telemetry } = await build(stored);
    engine.handleSequenceUpdated('night', {
      mode: 'manual',
      items: [],
      activeItemId: null,
      startedAt: null,
      loop: false,
    });
    telemetry.renameProgram('none', 'night', {
      type: 'radio',
      palazzoUrl: 'http://old-night:3100',
    });
    const stale = mockClients[1];

    await engine.renameProgram('demo', 'night');

    expect(stale.stop).toHaveBeenCalled();
    expect(mockClients).toHaveLength(3);
    // The stored program has no sequence, so none of the deleted program's remains.
    expect(engine.getOnAirView('night').mode).toBeNull();
    engine.onModuleDestroy();
  });

  it('leaves telemetry alone where it never starts: a rejected or deploy-candidate setting', async () => {
    const { telemetry } = await build(stored);
    telemetry.renameProgram('demo', 'tv', {
      type: 'tv',
      palazzoUrl: 'http://x',
    });
    telemetry.renameProgram('demo', 'none', null);
    process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
    telemetry.renameProgram('demo', 'candidate', {
      type: 'radio',
      palazzoUrl: 'http://x',
    });
    delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
    expect(mockClients).toHaveLength(1);
  });
});
