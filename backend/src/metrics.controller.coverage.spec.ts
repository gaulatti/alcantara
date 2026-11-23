import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { PalazzoMetricsPassthrough } from './observability/palazzo-metrics.passthrough';
import { MetricsTokenGuard } from './observability/metrics-token.guard';

describe('MetricsController', () => {
  it('renders managed metrics wrapping the radio metrics output', async () => {
    const radio = { render: jest.fn().mockReturnValue('radio_metric 1\n') };
    const managed = { render: jest.fn().mockResolvedValue('merged\n') };
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        { provide: RadioMetricsService, useValue: radio },
        { provide: ManagedMetricsService, useValue: managed },
        { provide: PalazzoMetricsPassthrough, useValue: { fetch: jest.fn() } },
      ],
    })
      .overrideGuard(MetricsTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const controller = moduleRef.get(MetricsController);
    await expect(controller.getMetrics()).resolves.toBe('merged\n');
    expect(managed.render).toHaveBeenCalledWith('radio_metric 1\n');
    expect(
      Reflect.getMetadata(
        '__headers__',
        MetricsController.prototype.getMetrics,
      ),
    ).toEqual([
      {
        name: 'Content-Type',
        value: 'text/plain; version=0.0.4; charset=utf-8',
      },
    ]);
  });

  describe('GET /metrics/palazzo', () => {
    async function build(body: string | null) {
      const passthrough = { fetch: jest.fn().mockResolvedValue(body) };
      const moduleRef = await Test.createTestingModule({
        controllers: [MetricsController],
        providers: [
          { provide: RadioMetricsService, useValue: {} },
          { provide: ManagedMetricsService, useValue: {} },
          { provide: PalazzoMetricsPassthrough, useValue: passthrough },
        ],
      })
        .overrideGuard(MetricsTokenGuard)
        .useValue({ canActivate: () => true })
        .compile();
      return moduleRef.get(MetricsController);
    }

    it('returns the body with the Prometheus content type', async () => {
      const controller = await build('palazzo_up 1\n');
      const response = { status: jest.fn() };
      await expect(controller.getPalazzoMetrics(response)).resolves.toBe(
        'palazzo_up 1\n',
      );
      // The content type is set by the @Header decorator, which works on the
      // production Fastify adapter; the handler never touches a header API.
      expect(
        Reflect.getMetadata(
          '__headers__',
          MetricsController.prototype.getPalazzoMetrics,
        ),
      ).toEqual([
        {
          name: 'Content-Type',
          value: 'text/plain; version=0.0.4; charset=utf-8',
        },
      ]);
      expect(response.status).not.toHaveBeenCalled();
    });

    it('answers 502 with an empty body on failure', async () => {
      const controller = await build(null);
      const response = { status: jest.fn() };
      await expect(controller.getPalazzoMetrics(response)).resolves.toBe('');
      expect(response.status).toHaveBeenCalledWith(502);
    });

    it('is behind the same MetricsTokenGuard as /metrics', () => {
      expect(
        Reflect.getMetadata(
          '__guards__',
          MetricsController.prototype.getPalazzoMetrics,
        ),
      ).toEqual(
        Reflect.getMetadata(
          '__guards__',
          MetricsController.prototype.getMetrics,
        ),
      );
      expect(
        Reflect.getMetadata(
          'path',
          MetricsController.prototype.getPalazzoMetrics,
        ),
      ).toBe('metrics/palazzo');
    });
  });
});
