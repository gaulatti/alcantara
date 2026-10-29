import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import type { ManagedMetricsService } from './managed-metrics.service';

function setup(
  options: {
    type?: string;
    url?: string;
    method?: string;
    status?: number;
  } = {},
) {
  const recordHttp = jest.fn();
  const interceptor = new HttpMetricsInterceptor({
    recordHttp,
  } as unknown as ManagedMetricsService);
  const context = {
    getType: () => options.type ?? 'http',
    switchToHttp: () => ({
      getRequest: () => ({
        method: options.method ?? 'GET',
        url: options.url ?? '/program/state?x=1',
      }),
      getResponse: () => ({ statusCode: options.status ?? 200 }),
    }),
  } as unknown as ExecutionContext;
  return { recordHttp, interceptor, context };
}

describe('HttpMetricsInterceptor', () => {
  it('passes non-http contexts through without recording', async () => {
    const { interceptor, context, recordHttp } = setup({ type: 'ws' });
    const handler: CallHandler = { handle: () => of('payload') };
    await expect(
      lastValueFrom(interceptor.intercept(context, handler)),
    ).resolves.toBe('payload');
    expect(recordHttp).not.toHaveBeenCalled();
  });

  it('records the response status and first route segment on success', async () => {
    const { interceptor, context, recordHttp } = setup({
      status: 201,
      method: 'POST',
    });
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );
    expect(recordHttp).toHaveBeenCalledWith(
      'POST',
      'program',
      201,
      expect.any(Number),
    );
    expect(recordHttp.mock.calls[0][3]).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['/', 'root'],
    ['/?q=1', 'root'],
    ['/metrics', 'metrics'],
    ['/radio/mixer/1', 'radio'],
    ['//', 'unknown'],
    ['', 'root'],
  ])('maps url %p to route group %p', async (url, group) => {
    // an empty url yields an empty path; it is neither "/" nor has a segment
    const expected = url === '' ? 'unknown' : group;
    const { interceptor, context, recordHttp } = setup({ url });
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );
    expect(recordHttp.mock.calls[0][1]).toBe(expected);
  });

  it('falls back to the unknown group when the url splits into no path segment', async () => {
    // Defensive `?? ''` in routeGroup: only reachable with a url-like object
    // whose split() yields no elements, which no real request produces.
    const { interceptor, recordHttp } = setup();
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: { split: () => [] } }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );
    expect(recordHttp).toHaveBeenCalledWith(
      'GET',
      'unknown',
      200,
      expect.any(Number),
    );
  });

  it('records the HttpException status on error and rethrows', async () => {
    const { interceptor, context, recordHttp } = setup();
    const failure = new BadRequestException('bad');
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => failure),
        }),
      ),
    ).rejects.toBe(failure);
    expect(recordHttp).toHaveBeenCalledWith(
      'GET',
      'program',
      400,
      expect.any(Number),
    );
  });

  it('records 500 for non-HTTP errors', async () => {
    const { interceptor, context, recordHttp } = setup();
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');
    expect(recordHttp).toHaveBeenCalledWith(
      'GET',
      'program',
      500,
      expect.any(Number),
    );
  });
});

describe('HttpMetricsInterceptor design metadata under unresolved circular imports', () => {
  it('records Object for the metrics dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./managed-metrics.service', () => ({}));
      const {
        HttpMetricsInterceptor: Isolated,
      } = require('./http-metrics.interceptor');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });
});
