import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { ManagedMetricsService } from './observability/managed-metrics.service';
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
});
