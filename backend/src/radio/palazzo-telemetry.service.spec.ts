import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { SongExecutionEngine } from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';
import type { PrismaService } from '../prisma.service';

function createService() {
  const prisma = {
    radioSettings: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    programState: {
      findUnique: jest.fn().mockResolvedValue({ type: 'radio' }),
    },
  };
  const engine = {
    setPalazzoTelemetry: jest.fn(),
    registerRadioProgram: jest.fn(),
    handlePalazzoSnapshot: jest.fn(),
    handlePalazzoEvent: jest.fn(),
    handlePalazzoStatus: jest.fn(),
  };
  const metrics = new RadioMetricsService();
  const machineClient = {
    validateBaseUrl: jest.fn((value: string) => value),
    connectEvents: jest.fn().mockRejectedValue(new Error('offline')),
    getPlaybackState: jest.fn().mockRejectedValue(new Error('offline')),
  };
  const service = new PalazzoRadioTelemetryService(
    prisma as unknown as PrismaService,
    engine as unknown as SongExecutionEngine,
    metrics,
    machineClient as any,
  );
  return { service, prisma, engine, metrics };
}

describe('PalazzoRadioTelemetryService instance ownership', () => {
  it('exposes the validation contract directly', () => {
    // validateInstance is private; reach it through the client callback
    // wiring by starting clients for two programs with distinct instances.
    const { service, prisma, engine } = createService();

    prisma.radioSettings.findMany.mockResolvedValue([
      {
        palazzoUrl: 'http://palazzo-a:3100',
        programState: { programId: 'radio-1', type: 'radio' },
      },
      {
        palazzoUrl: 'http://palazzo-b:3100',
        programState: { programId: 'radio-2', type: 'both' },
      },
      {
        palazzoUrl: 'http://palazzo-c:3100',
        programState: { programId: 'tv-1', type: 'tv' },
      },
    ]);

    return service.onModuleInit().then(() => {
      expect(engine.registerRadioProgram).toHaveBeenCalledTimes(2);
      expect(engine.registerRadioProgram).toHaveBeenCalledWith('radio-1');
      expect(engine.registerRadioProgram).toHaveBeenCalledWith('radio-2');
      const statuses = service.listStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.map((s) => s.programId).sort()).toEqual([
        'radio-1',
        'radio-2',
      ]);
      service.onModuleDestroy();
    });
  });

  it('rejects a second program claiming the same Palazzo instance', () => {
    const { service } = createService();
    const validate = service as unknown as {
      validateInstance: (pid: string, iid: string) => string;
    };
    expect(validate.validateInstance('radio-1', 'palazzo-a')).toBe('ok');
    expect(validate.validateInstance('radio-2', 'palazzo-a')).toBe('conflict');
    expect(validate.validateInstance('radio-2', 'palazzo-b')).toBe('ok');
    service.onModuleDestroy();
  });

  it('rejects an instance identity change under the same program', () => {
    const { service } = createService();
    const validate = service as unknown as {
      validateInstance: (pid: string, iid: string) => string;
    };
    expect(validate.validateInstance('radio-1', 'palazzo-a')).toBe('ok');
    expect(validate.validateInstance('radio-1', 'palazzo-z')).toBe('mismatch');
    service.onModuleDestroy();
  });

  it('releases the instance claim when a program stops', () => {
    const { service } = createService();
    const internal = service as unknown as {
      validateInstance: (pid: string, iid: string) => string;
      stopClient: (pid: string) => void;
      startClient: (pid: string, type: 'radio', url: string) => void;
    };
    expect(internal.validateInstance('radio-1', 'palazzo-a')).toBe('ok');
    internal.startClient('radio-1', 'radio', 'http://palazzo-a:3100');
    internal.stopClient('radio-1');
    expect(internal.validateInstance('radio-2', 'palazzo-a')).toBe('ok');
    service.onModuleDestroy();
  });
});

// gaulatti/alcantara#230: the engine reads Palazzo's state through the service.
describe('PalazzoRadioTelemetryService current state', () => {
  it('answers null for a program it has no client for, and asks the client otherwise', async () => {
    const { service } = createService();
    expect(await service.currentState('radio-unknown')).toBeNull();
    const state = { status: 'idle' };
    const client = { currentState: jest.fn().mockResolvedValue(state) };
    (service as unknown as { clients: Map<string, unknown> }).clients.set(
      'radio-1',
      client,
    );
    expect(await service.currentState('radio-1')).toBe(state);
    expect(client.currentState).toHaveBeenCalledTimes(1);
  });
});

// gaulatti/alcantara#257: the status says why there is no engine.
describe('PalazzoRadioTelemetryService unavailable reasons', () => {
  const setting = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    palazzoUrl: 'http://palazzo-a:3100',
    programState: { type: 'radio' },
    ...over,
  });

  afterEach(() => {
    delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
  });

  it.each([
    ['no settings row', null, 'radio-1'],
    ['no Palazzo URL', setting({ palazzoUrl: null }), 'radio-1'],
    ['an empty Palazzo URL', setting({ palazzoUrl: '' }), 'radio-1'],
  ])('says not-configured for %s', async (_name, row, programId) => {
    const { service, prisma } = createService();
    prisma.radioSettings.findFirst.mockResolvedValue(row);
    const status = await service.getStatusWithReason(programId);
    expect(status).toMatchObject({
      programId,
      connection: 'unavailable',
      degraded: false,
      reason: 'not-configured',
      palazzoUrl: '',
      instanceId: null,
      lastEventAt: null,
      lastSnapshotAt: null,
    });
    expect(status!.detail).toEqual(expect.any(String));
  });

  it.each([
    ['a TV program', { type: 'tv' }],
    ['a program with no state', null],
  ])('keeps answering null for %s', async (_name, state) => {
    const { service, prisma } = createService();
    prisma.programState.findUnique.mockResolvedValue(state);
    await expect(service.getStatusWithReason('tv-1')).resolves.toBeNull();
    expect(prisma.radioSettings.findFirst).not.toHaveBeenCalled();
  });

  it('answers null for a non-radio program even on a deploy candidate', async () => {
    process.env.ALCANTARA_DEPLOY_CANDIDATE = 'true';
    const { service, prisma } = createService();
    prisma.programState.findUnique.mockResolvedValue({ type: 'tv' });
    await expect(service.getStatusWithReason('tv-1')).resolves.toBeNull();
  });

  it('keeps the program type of a radio-capable program in the status', async () => {
    const { service, prisma } = createService();
    prisma.programState.findUnique.mockResolvedValue({ type: 'both' });
    prisma.radioSettings.findFirst.mockResolvedValue(
      setting({ programState: { type: 'both' }, palazzoUrl: null }),
    );
    await expect(service.getStatusWithReason('r')).resolves.toMatchObject({
      programType: 'both',
      reason: 'not-configured',
    });
  });

  it('says disabled for a configured program whose radio is disabled', async () => {
    const { service, prisma } = createService();
    prisma.radioSettings.findFirst.mockResolvedValue(
      setting({ enabled: false }),
    );
    await expect(service.getStatusWithReason('radio-1')).resolves.toMatchObject(
      { connection: 'unavailable', reason: 'disabled', programType: 'radio' },
    );
  });

  it('answers without a reason when a configured program has no client yet', async () => {
    const { service, prisma } = createService();
    prisma.radioSettings.findFirst.mockResolvedValue(setting());
    const status = await service.getStatusWithReason('radio-1');
    expect(status).toMatchObject({ connection: 'unavailable' });
    expect('reason' in status!).toBe(false);
  });

  it('says deploy-candidate without reading settings', async () => {
    process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
    const { service, prisma } = createService();
    await expect(service.getStatusWithReason('radio-1')).resolves.toMatchObject(
      { connection: 'unavailable', reason: 'deploy-candidate' },
    );
    expect(prisma.radioSettings.findFirst).not.toHaveBeenCalled();
  });

  it('says url-rejected, counts the rejection once and never echoes the URL', async () => {
    const { service, prisma, metrics, engine } = createService();
    const rejected = 'http://evil.example:9999/secret-path';
    const machine = (
      service as unknown as {
        machineClient: { validateBaseUrl: jest.Mock };
      }
    ).machineClient;
    machine.validateBaseUrl.mockImplementation(() => {
      throw new Error('not allowed');
    });
    prisma.radioSettings.findMany.mockResolvedValue([
      {
        palazzoUrl: rejected,
        programState: { programId: 'radio-1', type: 'radio' },
      },
    ]);
    await service.onModuleInit();
    expect(engine.registerRadioProgram).not.toHaveBeenCalled();
    expect(metrics.snapshot().palazzoConfigRejected).toBe(1);

    const first = await service.getStatusWithReason('radio-1');
    const second = await service.getStatusWithReason('radio-1');
    expect(first).toMatchObject({
      connection: 'unavailable',
      reason: 'url-rejected',
      palazzoUrl: '',
    });
    expect(JSON.stringify(first)).not.toContain('evil.example');
    expect(JSON.stringify(first)).not.toContain('secret-path');
    expect(second).toEqual(first);
    expect(prisma.radioSettings.findFirst).not.toHaveBeenCalled();
    // Reading the status does not count again.
    expect(metrics.snapshot().palazzoConfigRejected).toBe(1);
    expect(metrics.render()).toContain(
      'alcantara_palazzo_config_rejected_total 1',
    );
  });

  it('forgets a rejection when the settings change and the URL is accepted', async () => {
    const { service, prisma, metrics } = createService();
    const machine = (
      service as unknown as {
        machineClient: { validateBaseUrl: jest.Mock };
      }
    ).machineClient;
    machine.validateBaseUrl.mockImplementationOnce(() => {
      throw new Error('not allowed');
    });
    prisma.radioSettings.findFirst.mockResolvedValue(setting());
    await service.handleRadioSettingsChanged('radio-1');
    expect(metrics.snapshot().palazzoConfigRejected).toBe(1);
    prisma.radioSettings.findFirst.mockClear();
    await expect(service.getStatusWithReason('radio-1')).resolves.toMatchObject(
      { reason: 'url-rejected' },
    );

    await service.handleRadioSettingsChanged('radio-1');
    const live = await service.getStatusWithReason('radio-1');
    expect(live).toMatchObject({
      programId: 'radio-1',
      palazzoUrl: expect.any(String),
    });
    expect('reason' in live!).toBe(false);
    expect(metrics.snapshot().palazzoConfigRejected).toBe(1);
    service.onModuleDestroy();
  });

  it('forgets a rejection when the program is disabled afterwards', async () => {
    const { service, prisma } = createService();
    const machine = (
      service as unknown as {
        machineClient: { validateBaseUrl: jest.Mock };
      }
    ).machineClient;
    machine.validateBaseUrl.mockImplementationOnce(() => {
      throw new Error('not allowed');
    });
    prisma.radioSettings.findFirst.mockResolvedValueOnce(setting());
    await service.handleRadioSettingsChanged('radio-1');
    // The change handler only reads enabled settings, so a disabled program
    // yields no row there; the status read then finds it disabled.
    prisma.radioSettings.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(setting({ enabled: false }));
    await service.handleRadioSettingsChanged('radio-1');
    await expect(service.getStatusWithReason('radio-1')).resolves.toMatchObject(
      { reason: 'disabled' },
    );
  });

  it('answers the live status, unchanged and without a reason, when a client exists', async () => {
    const { service } = createService();
    const live = {
      programId: 'radio-1',
      programType: 'radio',
      palazzoUrl: 'http://palazzo-a:3100',
      instanceId: 'i',
      connection: 'connected',
      lastEventAt: null,
      lastSnapshotAt: null,
      degraded: false,
      detail: null,
    };
    (service as unknown as { clients: Map<string, unknown> }).clients.set(
      'radio-1',
      { getStatus: () => live },
    );
    const status = await service.getStatusWithReason('radio-1');
    expect(status).toBe(live);
    expect('reason' in status!).toBe(false);
  });
});
