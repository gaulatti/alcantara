import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { MetricsTokenGuard } from './metrics-token.guard';

jest.mock('node:fs', () => ({ readFileSync: jest.fn() }));
const readFileSyncMock = jest.mocked(readFileSync);

function guardWith(path?: string) {
  const get = jest.fn().mockReturnValue(path);
  return {
    guard: new MetricsTokenGuard({ get } as unknown as ConfigService),
    get,
  };
}

function context(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('MetricsTokenGuard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the default secret path when none is configured', () => {
    readFileSyncMock.mockReturnValue('scrape-token\n');
    const { guard, get } = guardWith(undefined);
    expect(guard.canActivate(context('Bearer scrape-token'))).toBe(true);
    expect(get).toHaveBeenCalledWith('METRICS_TOKEN_FILE');
    expect(readFileSyncMock).toHaveBeenCalledWith(
      '/run/secrets/alcantara-metrics-token',
      'utf8',
    );
  });

  it('reads the configured token file', () => {
    readFileSyncMock.mockReturnValue('  abc  ');
    const { guard } = guardWith('/custom/token');
    expect(guard.canActivate(context('Bearer abc'))).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/token', 'utf8');
  });

  it('answers 503 when the credential file cannot be read', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { guard } = guardWith('/missing');
    expect(() => guard.canActivate(context('Bearer x'))).toThrow(
      new ServiceUnavailableException('Metrics scrape credential unavailable'),
    );
  });

  it('answers 503 when the credential file is blank', () => {
    readFileSyncMock.mockReturnValue(' \n');
    const { guard } = guardWith('/blank');
    expect(() => guard.canActivate(context('Bearer '))).toThrow(
      ServiceUnavailableException,
    );
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', 'Basic secret'],
    ['same length wrong token', 'Bearer secreu'],
    ['shorter token', 'Bearer sec'],
    ['longer token', 'Bearer secretx'],
  ])('answers 401 for %s', (_label, header) => {
    readFileSyncMock.mockReturnValue('secret');
    const { guard } = guardWith('/token');
    expect(() => guard.canActivate(context(header))).toThrow(
      new UnauthorizedException('Metrics bearer token required'),
    );
  });

  it('records Object for the config dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      const { MetricsTokenGuard: Isolated } = require('./metrics-token.guard');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });
});
