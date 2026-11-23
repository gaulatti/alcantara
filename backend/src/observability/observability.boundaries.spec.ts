import {
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ManagedMetricsService } from './managed-metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

const fs: typeof import('node:fs') = require('node:fs');

describe('observability public failure and redaction boundaries', () => {
  it('fails closed when the default metrics-token file contains no credential', () => {
    const read = jest.spyOn(fs, 'readFileSync').mockReturnValue(' \r\n ');
    try {
      const config = { get: () => undefined } as unknown as ConfigService;
      const guard = new MetricsTokenGuard(config);
      const context = {
        switchToHttp: jest.fn(),
      } as unknown as ExecutionContext;
      expect(() => guard.canActivate(context)).toThrow(
        ServiceUnavailableException,
      );
      expect(context.switchToHttp).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledWith(
        '/run/secrets/alcantara-metrics-token',
        'utf8',
      );
    } finally {
      read.mockRestore();
    }
  });

  it('never publishes an unsafe build-version value as a Prometheus label', async () => {
    const previous = process.env.ALCANTARA_BUILD_VERSION;
    process.env.ALCANTARA_BUILD_VERSION = 'fixture/private-version\n';
    const metrics = new ManagedMetricsService();
    try {
      const info = await metrics.registry
        .getSingleMetric('alcantara_service_info')!
        .get();
      expect(info.values).toEqual([
        {
          value: 1,
          labels: {
            service: 'alcantara',
            runtime: 'nodejs',
            version: 'unknown',
          },
        },
      ]);
    } finally {
      metrics.registry.clear();
      if (previous === undefined) delete process.env.ALCANTARA_BUILD_VERSION;
      else process.env.ALCANTARA_BUILD_VERSION = previous;
    }
  });
});
