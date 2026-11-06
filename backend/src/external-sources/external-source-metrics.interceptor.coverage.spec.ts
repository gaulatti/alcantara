/* eslint-disable @typescript-eslint/no-require-imports */
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ExternalSourceMetricsInterceptor } from './external-source-metrics.interceptor';

function context(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
  } as unknown as ExecutionContext;
}

describe('ExternalSourceMetricsInterceptor coverage', () => {
  const recordExternalSource = jest.fn();
  const interceptor = new ExternalSourceMetricsInterceptor({
    recordExternalSource,
  } as unknown as ManagedMetricsService);

  beforeEach(() => recordExternalSource.mockReset());

  it('passes successful responses through without recording', async () => {
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    await expect(
      firstValueFrom(interceptor.intercept(context('GET', '/x'), handler)),
    ).resolves.toEqual({ ok: true });
    expect(recordExternalSource).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/external-sources/a/credentials/rotate', 'rotate'],
    ['POST', '/external-sources/a/redirects/validate', 'redirect'],
    ['POST', '/external-sources/a/reconcile', 'reconcile'],
    ['POST', '/external-sources', 'create'],
    ['PATCH', '/external-sources/a', 'update'],
    ['DELETE', '/external-sources/a', 'revoke'],
    ['GET', '/external-sources/a', 'read'],
  ])('classifies %s %s as %s', async (method, url, action) => {
    const failure = { status: 500 };
    const handler: CallHandler = { handle: () => throwError(() => failure) };
    await expect(
      firstValueFrom(interceptor.intercept(context(method, url), handler)),
    ).rejects.toBe(failure);
    expect(recordExternalSource).toHaveBeenCalledWith(action, 'failure');
  });

  it.each([
    ['a 4xx status', { status: 404 }, 'rejected'],
    ['the 400 lower bound', { status: 400 }, 'rejected'],
    ['the 499 upper bound', { status: 499 }, 'rejected'],
    ['a 5xx status', { status: 503 }, 'failure'],
    ['a status below 400', { status: 302 }, 'failure'],
    ['a non numeric status', { status: 'abc' }, 'failure'],
    ['an error without a status', new Error('boom'), 'failure'],
    ['a null error', null, 'failure'],
    ['a string error', 'boom', 'failure'],
  ])('records %s as %s', async (_name, error, result) => {
    const handler: CallHandler = { handle: () => throwError(() => error) };
    await expect(
      firstValueFrom(interceptor.intercept(context('GET', '/x'), handler)),
    ).rejects.toBe(error);
    expect(recordExternalSource).toHaveBeenCalledTimes(1);
    expect(recordExternalSource).toHaveBeenCalledWith('read', result);
  });

  it('falls back to Object paramtypes when the metrics class is undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { ExternalSourceMetricsInterceptor: Isolated } =
        require('./external-source-metrics.interceptor') as {
          ExternalSourceMetricsInterceptor: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.resetModules();
  });
});
