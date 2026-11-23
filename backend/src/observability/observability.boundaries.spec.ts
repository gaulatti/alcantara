import {
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
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

  it('leaves non-HTTP messages alone and records generic HTTP failures under a bounded unknown route', async () => {
    const metrics = { recordHttp: jest.fn() };
    const interceptor = new HttpMetricsInterceptor(
      metrics as unknown as ManagedMetricsService,
    );
    const nonHttp = {
      getType: () => 'ws',
      switchToHttp: jest.fn(),
    } as unknown as ExecutionContext;
    expect(
      await lastValueFrom(
        interceptor.intercept(nonHttp, { handle: () => of('frame') }),
      ),
    ).toBe('frame');
    expect(nonHttp.switchToHttp).not.toHaveBeenCalled();
    expect(metrics.recordHttp).not.toHaveBeenCalled();
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '' }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('fixture handler failure')),
        }),
      ),
    ).rejects.toThrow('fixture handler failure');
    expect(metrics.recordHttp).toHaveBeenCalledWith(
      'GET',
      'unknown',
      500,
      expect.any(Number),
    );
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
