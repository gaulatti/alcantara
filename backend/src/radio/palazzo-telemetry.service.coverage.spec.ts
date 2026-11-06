import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';

const mockClients: any[] = [];

jest.mock('./palazzo-program.client', () => ({
  PalazzoProgramClient: jest.fn().mockImplementation((options: any) => {
    const client = {
      options,
      start: jest.fn(),
      stop: jest.fn(),
      status: { programId: options.programId, degraded: false },
      getStatus: jest.fn(() => client.status),
    };
    mockClients.push(client);
    return client;
  }),
}));

function build() {
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
  const machineClient = {
    validateBaseUrl: jest.fn((value: string) => `approved:${value}`),
  };
  const service = new PalazzoRadioTelemetryService(
    prisma as any,
    engine as any,
    metrics as any,
    machineClient as any,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation();
  jest.spyOn(service['logger'], 'error').mockImplementation();
  return { service, prisma, engine, metrics, machineClient };
}

const setting = (
  programId: string,
  type: string,
  palazzoUrl: string | null,
) => ({
  palazzoUrl,
  programState: { programId, type },
});

describe('PalazzoRadioTelemetryService coverage', () => {
  beforeEach(() => {
    mockClients.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  describe('onModuleInit / onModuleDestroy', () => {
    it('registers itself with the engine and starts only radio-capable programs with a url', async () => {
      const { service, prisma, engine } = build();
      prisma.radioSettings.findMany.mockResolvedValue([
        setting('r1', 'radio', 'http://a'),
        setting('b1', 'both', 'http://b'),
        setting('tv', 'tv', 'http://c'),
        setting('r2', 'radio', null),
      ]);
      await service.onModuleInit();
      expect(engine.setPalazzoTelemetry).toHaveBeenCalledWith(service);
      expect(prisma.radioSettings.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        select: {
          palazzoUrl: true,
          programState: { select: { programId: true, type: true } },
        },
      });
      expect(mockClients.map((c) => c.options.programId)).toEqual(['r1', 'b1']);
      expect(mockClients[0].options).toMatchObject({
        programType: 'radio',
        palazzoUrl: 'approved:http://a',
      });
      expect(mockClients[1].options.programType).toBe('both');
      expect(mockClients[0].start).toHaveBeenCalled();
      expect(engine.registerRadioProgram).toHaveBeenCalledTimes(2);
    });

    it('stops all clients and clears ownership on destroy', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findMany.mockResolvedValue([
        setting('r1', 'radio', 'http://a'),
      ]);
      await service.onModuleInit();
      mockClients[0].options.callbacks.validateInstance('r1', 'inst');
      service.onModuleDestroy();
      expect(mockClients[0].stop).toHaveBeenCalled();
      expect(service.listStatuses()).toEqual([]);
      // ownership cleared: another program may now claim the instance
      expect(
        mockClients[0].options.callbacks.validateInstance('other', 'inst'),
      ).toBe('ok');
    });
  });

  describe('startClient', () => {
    it('does not start a second client for the same program', async () => {
      const { service, prisma, engine } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      service['startClient']('r1', 'radio', 'http://a');
      expect(mockClients).toHaveLength(1);
      expect(engine.registerRadioProgram).toHaveBeenCalledTimes(1);
    });

    it('logs and skips when the palazzo url is not approved', async () => {
      const { service, prisma, engine, machineClient } = build();
      machineClient.validateBaseUrl.mockImplementation(() => {
        throw new Error('rejected');
      });
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://evil',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      expect(mockClients).toHaveLength(0);
      expect(engine.registerRadioProgram).not.toHaveBeenCalled();
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Palazzo URL configuration rejected for r1',
      );
    });

    it('wires client callbacks to the engine and status tracking', async () => {
      const { service, prisma, engine, metrics } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      const { callbacks } = mockClients[0].options;
      callbacks.onSnapshot('r1', { snap: 1 });
      expect(engine.handlePalazzoSnapshot).toHaveBeenCalledWith('r1', {
        snap: 1,
      });
      callbacks.onEvent('r1', { ev: 1 });
      expect(engine.handlePalazzoEvent).toHaveBeenCalledWith('r1', { ev: 1 });
      const status = { connection: 'connected', lastSnapshotAt: 'x' };
      callbacks.onStatus('r1', status);
      expect(engine.handlePalazzoStatus).toHaveBeenCalledWith('r1', status);
      expect(metrics.recordDegradedPrograms).toHaveBeenCalled();
    });
  });

  describe('handleRadioSettingsChanged', () => {
    it('does nothing more when no enabled setting exists', async () => {
      const { service, prisma } = build();
      await service.handleRadioSettingsChanged('r1');
      expect(prisma.radioSettings.findFirst).toHaveBeenCalledWith({
        where: { enabled: true, programState: { programId: 'r1' } },
        select: {
          palazzoUrl: true,
          programState: { select: { type: true } },
        },
      });
      expect(mockClients).toHaveLength(0);
    });

    it('does not start non-radio programs', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'tv' },
      });
      await service.handleRadioSettingsChanged('r1');
      expect(mockClients).toHaveLength(0);
    });

    it('does not start without a palazzo url', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: '',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      expect(mockClients).toHaveLength(0);
    });

    it('restarts a running client, releasing its instance ownership', async () => {
      const { service, prisma, metrics } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      const first = mockClients[0];
      first.options.callbacks.validateInstance('r1', 'inst-1');
      first.options.callbacks.onStatus('r1', { degraded: false });
      await service.handleRadioSettingsChanged('r1');
      expect(first.stop).toHaveBeenCalled();
      expect(mockClients).toHaveLength(2);
      expect(metrics.recordStaleTelemetryPrograms).toHaveBeenCalled();
      // ownership of inst-1 was released, so another program can take it
      expect(
        mockClients[1].options.callbacks.validateInstance('r2', 'inst-1'),
      ).toBe('ok');
    });

    it('keeps ownership recorded for another program when stopping a client without an instance', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      await service.handleRadioSettingsChanged('r2');
      mockClients[1].options.callbacks.validateInstance('r2', 'shared');
      // r1 never validated, then force a stale mapping pointing at another owner
      service['instanceByProgram'].set('r1', 'shared');
      prisma.radioSettings.findFirst.mockResolvedValue(null);
      await service.handleRadioSettingsChanged('r1');
      expect(service['ownerByInstance'].get('shared')).toBe('r2');
    });
  });

  describe('validateInstance', () => {
    it('accepts, rejects conflicts and mismatches', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      await service.handleRadioSettingsChanged('r2');
      const v1 = mockClients[0].options.callbacks.validateInstance;
      const v2 = mockClients[1].options.callbacks.validateInstance;
      expect(v1('r1', 'i1')).toBe('ok');
      expect(v1('r1', 'i1')).toBe('ok');
      expect(v2('r2', 'i1')).toBe('conflict');
      expect(v1('r1', 'i2')).toBe('mismatch');
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Palazzo instance i1 is already owned by r1; rejecting r2',
      );
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Program r1 expected Palazzo instance i1 but found i2',
      );
    });
  });

  describe('isReconciled / getStatus / listStatuses', () => {
    it('is false without a client or a reported status', async () => {
      const { service, prisma } = build();
      expect(service.isReconciled('r1')).toBe(false);
      expect(service.getStatus('r1')).toBeNull();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      expect(service.isReconciled('r1')).toBe(false);
    });

    it('requires a connected/polling connection with a snapshot', async () => {
      const { service, prisma } = build();
      prisma.radioSettings.findFirst.mockResolvedValue({
        palazzoUrl: 'http://a',
        programState: { type: 'radio' },
      });
      await service.handleRadioSettingsChanged('r1');
      const onStatus = mockClients[0].options.callbacks.onStatus;
      onStatus('r1', { connection: 'connected', lastSnapshotAt: 't' });
      expect(service.isReconciled('r1')).toBe(true);
      onStatus('r1', { connection: 'polling', lastSnapshotAt: 't' });
      expect(service.isReconciled('r1')).toBe(true);
      onStatus('r1', { connection: 'connected', lastSnapshotAt: null });
      expect(service.isReconciled('r1')).toBe(false);
      onStatus('r1', { connection: 'error', lastSnapshotAt: 't' });
      expect(service.isReconciled('r1')).toBe(false);
      expect(service.getStatus('r1')).toBe(mockClients[0].status);
      expect(service.listStatuses()).toEqual([mockClients[0].status]);
    });
  });

  describe('aggregate metrics', () => {
    it('counts degraded and stale programs', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
      try {
        const { service, prisma, metrics } = build();
        prisma.radioSettings.findFirst.mockResolvedValue({
          palazzoUrl: 'http://a',
          programState: { type: 'radio' },
        });
        for (const id of ['a', 'b', 'c', 'd'])
          await service.handleRadioSettingsChanged(id);
        mockClients[0].status = { degraded: true, lastEventAt: null };
        mockClients[1].status = {
          degraded: false,
          lastEventAt: '2026-10-02T09:59:50.000Z',
        };
        mockClients[2].status = {
          degraded: true,
          lastEventAt: '2026-10-02T09:59:59.000Z',
        };
        mockClients[3].status = { degraded: false, lastEventAt: null };
        mockClients[0].options.callbacks.onStatus('a', mockClients[0].status);
        expect(metrics.recordDegradedPrograms).toHaveBeenLastCalledWith(2);
        expect(metrics.recordStaleTelemetryPrograms).toHaveBeenLastCalledWith(
          0,
        );
        jest.setSystemTime(new Date('2026-10-02T10:00:06.000Z'));
        mockClients[0].options.callbacks.onStatus('a', mockClients[0].status);
        expect(metrics.recordStaleTelemetryPrograms).toHaveBeenLastCalledWith(
          1,
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
