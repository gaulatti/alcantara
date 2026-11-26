import { Logger } from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { SceneAssetScope } from './scene-asset-scope';

// gaulatti/alcantara#122: every way the team cannot serve the read ends in the unscoped read, counted.
describe('SceneAssetScope', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const build = (program: () => Promise<unknown>, stationTeam = 7) => {
    const metrics = new ManagedMetricsService();
    const prisma = {
      name: 'all',
      program: { findUnique: jest.fn(program) },
      // $extends stands in for forTeam.
      $extends: jest.fn(() => ({ name: 'team' })),
    };
    const scope = new SceneAssetScope(
      prisma as never,
      { teamId: stationTeam } as never,
      metrics,
    );
    const read = (rows: Record<string, string | Error>) =>
      scope.read('program-1', (db) => {
        const row = rows[(db as unknown as { name: string }).name];
        return row instanceof Error
          ? Promise.reject(row)
          : Promise.resolve(row ?? null);
      });
    return { metrics, prisma, read };
  };

  it('reads unscoped, without a program lookup, when there is no station team', async () => {
    const { read, prisma } = build(() => Promise.resolve(null), 0);
    await expect(read({ all: 'any' })).resolves.toBe('any');
    expect(prisma.program.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['no-team', () => Promise.resolve({ teamId: null }), {}],
    ['no-team', () => Promise.resolve({ teamId: 0 }), {}],
    ['no-team', () => Promise.resolve(null), {}],
    ['lookup-failed', () => Promise.reject(new Error('db')), {}],
    [
      'lookup-failed',
      () => Promise.resolve({ teamId: 7 }),
      { team: new Error('scoped') },
    ],
  ])('reads unscoped and counts %s', async (reason, program, rows) => {
    const { read, metrics } = build(program);
    const all = { ...rows, all: 'theirs' };
    await expect(read(all)).resolves.toBe('theirs');
    await expect(read(all)).resolves.toBe('theirs');
    await expect(metrics.registry.metrics()).resolves.toContain(
      `alcantara_scene_asset_scope_refusals_total{reason="${reason}"} 2`,
    );
    // Counted every time, logged once per program and reason.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to Object metadata when its dependencies are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('./scene-asset-scope') as {
        SceneAssetScope: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', isolated.SceneAssetScope),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../auth/pompeii.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});
