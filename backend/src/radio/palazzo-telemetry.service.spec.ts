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
