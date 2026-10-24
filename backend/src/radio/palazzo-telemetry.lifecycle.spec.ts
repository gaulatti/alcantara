import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import {
  PalazzoProgramClient,
  type PalazzoProgramClientOptions,
} from './palazzo-program.client';
import type {
  PalazzoProgramStatus,
  PalazzoPlaybackState,
  PalazzoPlaybackEvent,
} from './palazzo-contract';
import type { PrismaService } from '../prisma.service';
import type { SongExecutionEngine } from './song-execution.engine';
import type { RadioMetricsService } from './radio-metrics.service';
import type { PalazzoMachineClient } from './palazzo-machine.client';

jest.mock('./palazzo-program.client', () => ({
  PalazzoProgramClient: jest.fn(),
}));

describe('telemetry supervisor lifecycle and client callback contracts', () => {
  let clients: Array<{
    options: PalazzoProgramClientOptions;
    status: PalazzoProgramStatus;
    start: jest.Mock;
    stop: jest.Mock;
    getStatus: jest.Mock;
  }>;
  const row = (
    programId: string,
    type = 'radio',
    palazzoUrl: string | null = 'http://palazzo:3100',
  ) => ({ programState: { programId, type }, palazzoUrl });

  beforeEach(() => {
    clients = [];
    (PalazzoProgramClient as jest.Mock).mockImplementation(
      (options: PalazzoProgramClientOptions) => {
        const client = {
          options,
          status: {
            programId: options.programId,
            programType: options.programType,
            palazzoUrl: options.palazzoUrl,
            instanceId: null,
            connection: 'connecting',
            lastSnapshotAt: null,
            lastEventAt: null,
            degraded: true,
            detail: null,
          } as PalazzoProgramStatus,
          start: jest.fn(),
          stop: jest.fn(),
          getStatus: jest.fn(),
        };
        client.start.mockImplementation(() =>
          options.callbacks.onStatus(options.programId, client.status),
        );
        client.getStatus.mockImplementation(() => client.status);
        clients.push(client);
        return client;
      },
    );
  });

  function fixture() {
    const prisma = {
      radioSettings: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const engine = {
      setPalazzoTelemetry: jest.fn(),
      registerRadioProgram: jest.fn(),
      handlePalazzoSnapshot: jest.fn(),
      handlePalazzoEvent: jest.fn(),
      handlePalazzoStatus: jest.fn(),
    };
    const metrics = {
      recordDegradedPrograms: jest.fn(),
      recordStaleTelemetryPrograms: jest.fn(),
    };
    const machine = { validateBaseUrl: jest.fn((url: string) => url) };
    const service = new PalazzoRadioTelemetryService(
      prisma as unknown as PrismaService,
      engine as unknown as SongExecutionEngine,
      metrics as unknown as RadioMetricsService,
      machine as unknown as PalazzoMachineClient,
    );
    return { service, prisma, engine, metrics, machine };
  }

  function emit(index: number, update: Partial<PalazzoProgramStatus>) {
    const client = clients[index];
    client.status = { ...client.status, ...update };
    client.options.callbacks.onStatus(client.options.programId, client.status);
  }

  it('starts only radio-capable approved configured programs and tolerates repeated initialization', async () => {
    const { service, prisma, machine, engine } = fixture();
    prisma.radioSettings.findMany.mockResolvedValue([
      row('radio'),
      row('both', 'both'),
      row('tv', 'tv'),
      row('no-url', 'radio', null),
      row('bad-url', 'radio', 'bad'),
    ]);
    machine.validateBaseUrl.mockImplementation((url) => {
      if (url === 'bad') throw new Error('not approved');
      return url;
    });
    await service.onModuleInit();
    await service.onModuleInit();
    expect(engine.setPalazzoTelemetry).toHaveBeenCalledWith(service);
    expect(clients).toHaveLength(2);
    expect(engine.registerRadioProgram.mock.calls).toEqual([
      ['radio'],
      ['both'],
    ]);
    expect(service.listStatuses().map((status) => status.programId)).toEqual([
      'radio',
      'both',
    ]);
    expect(service.getStatus('radio')).toBe(clients[0].status);
    expect(service.getStatus('missing')).toBeNull();
    expect(service.isReconciled('missing')).toBe(false);
    service.onModuleDestroy();
    expect(clients.every((client) => client.stop.mock.calls.length === 1)).toBe(
      true,
    );
    expect(service.listStatuses()).toEqual([]);
    expect(service.getStatus('radio')).toBeNull();
  });

  it.each([null, row('radio', 'tv'), row('radio', 'radio', null)])(
    'removes an existing client before disabled/inapplicable setting %j',
    async (setting) => {
      const { service, prisma, engine } = fixture();
      prisma.radioSettings.findMany.mockResolvedValue([row('radio')]);
      await service.onModuleInit();
      prisma.radioSettings.findFirst.mockResolvedValue(setting);
      await service.handleRadioSettingsChanged('radio');
      expect(clients[0].stop).toHaveBeenCalledTimes(1);
      expect(service.getStatus('radio')).toBeNull();
      expect(engine.registerRadioProgram).toHaveBeenCalledTimes(1);
      expect(prisma.radioSettings.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { enabled: true, programState: { programId: 'radio' } },
        }),
      );
    },
  );

  it('starts a newly enabled program and replaces a changed private endpoint', async () => {
    const { service, prisma } = fixture();
    prisma.radioSettings.findFirst.mockResolvedValue(
      row('new', 'both', 'http://new:3100'),
    );
    await service.handleRadioSettingsChanged('new');
    expect(clients[0].options).toMatchObject({
      programId: 'new',
      programType: 'both',
      palazzoUrl: 'http://new:3100',
    });
    prisma.radioSettings.findFirst.mockResolvedValue(
      row('new', 'radio', 'http://replacement:3100'),
    );
    await service.handleRadioSettingsChanged('new');
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients[1].options.palazzoUrl).toBe('http://replacement:3100');
    service.onModuleDestroy();
  });

  it('forwards snapshot and event callbacks with their actual program identity', async () => {
    const { service, prisma, engine } = fixture();
    prisma.radioSettings.findMany.mockResolvedValue([row('radio')]);
    await service.onModuleInit();
    const snapshot: PalazzoPlaybackState = {
      schemaVersion: 1,
      instanceId: 'instance',
      bootId: 'boot',
      sequence: 1,
      availability: 'available',
      status: 'idle',
      liquidsoap: {
        running: true,
        connected: true,
        staleSince: null,
        lastSampleAt: null,
      },
      icecast: { connected: true },
      track: null,
      intro: null,
      positionSeconds: 0,
      remainingSeconds: null,
      levels: {
        song: { rms: 0, peak: 0 },
        instant: { rms: 0, peak: 0 },
        output: { rms: 0, peak: 0 },
      },
    };
    const event: PalazzoPlaybackEvent = {
      schemaVersion: 1,
      id: 'boot:2',
      instanceId: 'instance',
      bootId: 'boot',
      sequence: 2,
      type: 'heartbeat',
      occurredAt: new Date().toISOString(),
      data: {},
    };
    clients[0].options.callbacks.onSnapshot('radio', snapshot);
    clients[0].options.callbacks.onEvent('radio', event);
    expect(engine.handlePalazzoSnapshot).toHaveBeenCalledWith(
      'radio',
      snapshot,
    );
    expect(engine.handlePalazzoEvent).toHaveBeenCalledWith('radio', event);
    service.onModuleDestroy();
  });

  it.each([
    ['connecting', null, false],
    ['connected', null, false],
    ['connected', '2026-10-24T12:00:00.000Z', true],
    ['polling', '2026-10-24T12:00:00.000Z', true],
    ['unavailable', '2026-10-24T12:00:00.000Z', false],
  ] as const)(
    'requires a usable %s connection and an authoritative snapshot',
    async (connection, lastSnapshotAt, expected) => {
      const { service, prisma, engine } = fixture();
      prisma.radioSettings.findMany.mockResolvedValue([row('radio')]);
      await service.onModuleInit();
      emit(0, { connection, lastSnapshotAt });
      expect(service.isReconciled('radio')).toBe(expected);
      expect(engine.handlePalazzoStatus).toHaveBeenLastCalledWith(
        'radio',
        clients[0].status,
      );
      service.onModuleDestroy();
    },
  );

  it('isolates instance conflicts, refuses identity drift and releases ownership when a program stops', async () => {
    const { service, prisma } = fixture();
    prisma.radioSettings.findMany.mockResolvedValue([row('one'), row('two')]);
    await service.onModuleInit();
    const first = clients[0].options.callbacks.validateInstance;
    const second = clients[1].options.callbacks.validateInstance;
    expect(first('one', 'instance-a')).toBe('ok');
    expect(first('one', 'instance-a')).toBe('ok');
    expect(second('two', 'instance-a')).toBe('conflict');
    expect(first('one', 'different')).toBe('mismatch');
    await service.handleRadioSettingsChanged('one');
    expect(second('two', 'instance-a')).toBe('ok');
    service.onModuleDestroy();
  });

  it('refreshes aggregate degraded and stale metrics on public status callbacks and removals', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-24T12:00:20Z') });
    try {
      const { service, prisma, metrics } = fixture();
      prisma.radioSettings.findMany.mockResolvedValue([row('one'), row('two')]);
      await service.onModuleInit();
      emit(0, { degraded: false, lastEventAt: '2026-10-24T12:00:04Z' });
      emit(1, { degraded: true, lastEventAt: '2026-10-24T12:00:05Z' });
      expect(metrics.recordDegradedPrograms).toHaveBeenLastCalledWith(1);
      expect(metrics.recordStaleTelemetryPrograms).toHaveBeenLastCalledWith(1);
      await service.handleRadioSettingsChanged('one');
      expect(metrics.recordDegradedPrograms).toHaveBeenLastCalledWith(1);
      expect(metrics.recordStaleTelemetryPrograms).toHaveBeenLastCalledWith(0);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
