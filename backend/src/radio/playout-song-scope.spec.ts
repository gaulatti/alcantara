import { Logger } from '@nestjs/common';
import { PlayoutSongScope } from './playout-song-scope';
import { RadioMetricsService } from './radio-metrics.service';

// Playout scoping never takes anything off air (gaulatti/alcantara#122): every way the scope can fail to serve a read
// ends in the unscoped read, and is counted.
describe('PlayoutSongScope', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const build = (
    program: () => Promise<{ teamId: number | null } | null>,
    stationTeam = 7,
  ) => {
    const metrics = new RadioMetricsService();
    // $extends stands in for forTeam: it hands back the team's client.
    const teamDb = { name: 'team' };
    const prisma = {
      name: 'all',
      program: { findUnique: jest.fn(program) },
      $extends: jest.fn(() => teamDb),
    };
    const scope = new PlayoutSongScope(
      prisma as never,
      { teamId: stationTeam } as never,
      metrics,
    );
    return { scope, metrics, prisma };
  };
  const count = (metrics: RadioMetricsService, reason: string) =>
    Number(
      metrics
        .render()
        .split('\n')
        .find((line) =>
          line.startsWith(
            `alcantara_radio_song_scope_refusals_total{path="cover",reason="${reason}"}`,
          ),
        )
        ?.split(' ')[1],
    );
  const run = (
    scope: PlayoutSongScope,
    rows: Partial<Record<string, string | Error>>,
  ) =>
    scope.read(
      'cover',
      'radio-1',
      (db) => {
        const row = rows[(db as unknown as { name: string }).name];
        return row instanceof Error
          ? Promise.reject(row)
          : Promise.resolve(row ?? null);
      },
      (result) => result !== null,
    );
  const inTeam = () => Promise.resolve({ teamId: 7 });

  it('reads unscoped, without looking up the program, when there is no station team', async () => {
    const { scope, prisma } = build(inTeam, 0);
    await expect(run(scope, { all: 'any' })).resolves.toBe('any');
    expect(prisma.program.findUnique).not.toHaveBeenCalled();
  });

  it("serves the team's song and counts nothing", async () => {
    const { scope, metrics } = build(inTeam);
    await expect(run(scope, { team: 'own', all: 'other' })).resolves.toBe(
      'own',
    );
    expect(metrics.render()).not.toMatch(
      /song_scope_refusals_total\{[^}]*\} [1-9]/,
    );
  });

  it('counts nothing when no team has the song', async () => {
    const { scope, metrics } = build(inTeam);
    await expect(run(scope, {})).resolves.toBeNull();
    expect(count(metrics, 'other-team')).toBe(0);
  });

  it.each([
    ['other-team', inTeam, { all: 'theirs' }],
    ['no-team', () => Promise.resolve({ teamId: null }), { all: 'theirs' }],
    ['no-team', () => Promise.resolve(null), { all: 'theirs' }],
    ['no-team', () => Promise.resolve({ teamId: 0 }), { all: 'theirs' }],
    ['lookup-failed', () => Promise.reject(new Error('db')), { all: 'theirs' }],
    ['lookup-failed', inTeam, { team: new Error('scoped'), all: 'theirs' }],
  ])('still serves the song and counts %s', async (reason, program, rows) => {
    const { scope, metrics } = build(program);
    await expect(run(scope, rows)).resolves.toBe('theirs');
    await expect(run(scope, rows)).resolves.toBe('theirs');
    expect(count(metrics, reason)).toBe(2);
    // Counted every time, logged once per program, path and reason.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('lets an unscoped read fail as it did before', async () => {
    const { scope } = build(inTeam);
    await expect(run(scope, { all: new Error('down') })).rejects.toThrow(
      'down',
    );
  });

  it('falls back to Object metadata when its dependencies are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('./radio-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('./playout-song-scope') as {
        PlayoutSongScope: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', isolated.PlayoutSongScope),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../auth/pompeii.service');
    jest.dontMock('./radio-metrics.service');
  });

  it('ignores a path or reason it does not know', () => {
    const metrics = new RadioMetricsService();
    metrics.recordRadioSongScopeRefusal('nonsense' as never, 'no-team');
    metrics.recordRadioSongScopeRefusal('cover', 'nonsense' as never);
    expect(metrics.render()).not.toMatch('nonsense');
  });
});
