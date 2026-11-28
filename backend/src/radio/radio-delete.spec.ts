import { Logger } from '@nestjs/common';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { SongExecutionEngine } from './song-execution.engine';

// A deleted radio program leaves nothing running: its engine timers stop and Palazzo is no longer followed for it.

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

async function build() {
  mockClients.length = 0;
  const prisma = {
    radioSettings: {
      findMany: jest.fn().mockResolvedValue([
        {
          ...stored,
          programState: { ...stored.programState, programId: 'demo' },
        },
      ]),
    },
  };
  const metrics = new Proxy({}, { get: () => jest.fn() });
  const publisher = new Proxy({}, { get: () => () => Promise.resolve() });
  const flight = {
    isClockedLogRunning: () => false,
    removeProgram: jest.fn(),
  };
  const engine = new SongExecutionEngine(
    {} as never,
    flight as never,
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
  return { engine, telemetry, flight };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('deleting a radio program', () => {
  it('stops its Palazzo client and drops its engine state, and sends no command', async () => {
    const { engine, telemetry, flight } = await build();
    mockClients[0].snapshot();
    engine.handleSequenceUpdated('demo', {
      mode: 'manual',
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
    });
    expect(engine.getOnAirView('demo').mode).toBe('manual');

    engine.removeProgram('demo');

    expect(flight.removeProgram).toHaveBeenCalledWith('demo');
    expect(mockClients[0].stop).toHaveBeenCalled();
    expect(telemetry.getStatus('demo')).toBeNull();
    expect(telemetry.isReconciled('demo')).toBe(false);
    expect(engine.getOnAirView('demo').mode).toBeNull();
    expect(mockClients).toHaveLength(1);
  });

  it('is nothing for a program with no engine', async () => {
    const { engine, telemetry } = await build();
    engine.removeProgram('television');
    expect(mockClients[0].stop).not.toHaveBeenCalled();
    expect(telemetry.getStatus('demo')).not.toBeNull();
    engine.onModuleDestroy();
  });
});
