import { ConfigService } from '@nestjs/config';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import type { PrismaService } from '../prisma.service';
import type { SongExecutionEngine } from './song-execution.engine';

describe('real Palazzo client before its first asynchronous transport status', () => {
  it('keeps a registered connecting client unreconciled until actual telemetry arrives', async () => {
    const prisma = {
      radioSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            palazzoUrl: 'http://palazzo:3100',
            programState: { programId: 'radio', type: 'radio' },
          },
        ]),
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
    const transport = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () =>
              reject(new DOMException('Local fixture closed', 'AbortError')),
            { once: true },
          );
        }),
    );
    const metrics = new RadioMetricsService();
    const machine = new PalazzoMachineClient(
      new ConfigService({
        NODE_ENV: 'test',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      }),
      metrics,
      transport as unknown as typeof fetch,
    );
    const service = new PalazzoRadioTelemetryService(
      prisma as unknown as PrismaService,
      engine as unknown as SongExecutionEngine,
      metrics,
      machine,
    );
    try {
      await service.onModuleInit();
      expect(engine.registerRadioProgram).toHaveBeenCalledWith('radio');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][0]).toBe(
        'http://palazzo:3100/v1/programs/radio/playback/events',
      );
      expect(engine.handlePalazzoStatus).not.toHaveBeenCalled();
      expect(service.getStatus('radio')).toMatchObject({
        connection: 'connecting',
        lastSnapshotAt: null,
      });
      expect(service.isReconciled('radio')).toBe(false);
      expect(engine.handlePalazzoSnapshot).not.toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(service.listStatuses()).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
