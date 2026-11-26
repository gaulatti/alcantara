import { Logger } from '@nestjs/common';
import {
  PROGRAM_TEAM_CACHE_LIMIT,
  PROGRAM_TEAM_LOOKUP_TIMEOUT_MS,
  PROGRAM_TEAM_TTL_MS,
  ProgramTeamAccess,
} from './program-team-access';
import {
  programIdsOf,
  ProgramTeamInterceptor,
} from './program-team.interceptor';

describe('programIdsOf', () => {
  it('collects path, query and body ids once each, ignoring blanks and non-strings', () => {
    expect(
      programIdsOf({
        params: { programId: 'a' },
        query: { programId: 'a' },
        body: { programId: 'b' },
      }),
    ).toEqual(['a', 'b']);
    expect(
      programIdsOf({ query: { programId: ' ' }, body: { programId: 7 } }),
    ).toEqual([]);
    expect(programIdsOf({})).toEqual([]);
  });

  it('defaults a realtime ticket to main only when it names none', () => {
    const routeOptions = { url: '/auth/realtime-ticket' };
    expect(programIdsOf({ routeOptions, body: {} })).toEqual(['main']);
    expect(programIdsOf({ routeOptions, body: { programId: 'a' } })).toEqual([
      'a',
    ]);
  });
});

describe('ProgramTeamInterceptor', () => {
  it('looks several programs up together, so a hung database costs one timeout', async () => {
    const waiting: (() => void)[] = [];
    const access = {
      allows: jest.fn(
        () => new Promise<boolean>((done) => waiting.push(() => done(true))),
      ),
    };
    const interceptor = new ProgramTeamInterceptor(access as never);
    const request = {
      params: { programId: 'a' },
      body: { programId: 'b' },
      user: { authorization: { teamId: 7 } },
    };
    const handled = interceptor.intercept(
      {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request }),
      } as never,
      { handle: () => 'handled' as never },
    );
    // Both lookups are under way before either has answered.
    expect(access.allows.mock.calls).toEqual([
      ['a', 7],
      ['b', 7],
    ]);
    waiting.forEach((answer) => answer());
    await expect(handled).resolves.toBe('handled');
  });

  it('does not check what is not HTTP', async () => {
    const access = { allows: jest.fn() };
    const interceptor = new ProgramTeamInterceptor(access as never);
    const handled = {};
    await expect(
      interceptor.intercept({ getType: () => 'rpc' } as never, {
        handle: () => handled as never,
      }),
    ).resolves.toBe(handled);
    expect(access.allows).not.toHaveBeenCalled();
  });
});

describe('ProgramTeamAccess', () => {
  it('does not look anything up for station team 0', async () => {
    const prisma = { program: { findUnique: jest.fn() } };
    const access = new ProgramTeamAccess(
      prisma as never,
      { teamId: 0 } as never,
      {} as never,
    );
    await expect(access.allows('any', 0)).resolves.toBe(true);
    await expect(access.allowsStation('any')).resolves.toBe(true);
    expect(prisma.program.findUnique).not.toHaveBeenCalled();
  });
});

describe('ProgramTeamAccess cache', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const build = () => {
    const findUnique = jest.fn().mockResolvedValue({ teamId: 7 });
    const metrics = { recordProgramTeamCheck: jest.fn() };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const access = new ProgramTeamAccess(
      { program: { findUnique } } as never,
      { teamId: 7 } as never,
      metrics as never,
    );
    return { access, findUnique, metrics };
  };

  it('reads a program once until the entry expires or is invalidated', async () => {
    const { access, findUnique } = build();
    await access.allows('a', 7);
    jest.advanceTimersByTime(PROGRAM_TEAM_TTL_MS - 1);
    await access.allows(' a ', 7);
    expect(findUnique).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await access.allows('a', 7);
    expect(findUnique).toHaveBeenCalledTimes(2);
    access.invalidate('a');
    findUnique.mockResolvedValue({ teamId: 8 });
    await expect(access.allows('a', 7)).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it('allows a request whose lookup fails or hangs, and counts it', async () => {
    const { access, findUnique, metrics } = build();
    findUnique.mockRejectedValueOnce(new Error('down'));
    await expect(access.allows('a', 7)).resolves.toBe(true);
    findUnique.mockReturnValueOnce(new Promise(() => {}));
    const hung = access.allows('b', 7);
    await jest.advanceTimersByTimeAsync(PROGRAM_TEAM_LOOKUP_TIMEOUT_MS);
    await expect(hung).resolves.toBe(true);
    expect(metrics.recordProgramTeamCheck.mock.calls).toEqual([
      ['lookup-failed'],
      ['lookup-failed'],
    ]);
  });

  it('keeps applying the last team read when a refresh fails', async () => {
    const { access, findUnique } = build();
    findUnique.mockResolvedValueOnce({ teamId: 8 });
    await expect(access.allows('a', 7)).resolves.toBe(false);
    jest.advanceTimersByTime(PROGRAM_TEAM_TTL_MS);
    findUnique.mockRejectedValueOnce('down');
    await expect(access.allows('a', 7)).resolves.toBe(false);
  });

  it('stays bounded however many ids are asked', async () => {
    const { access, findUnique } = build();
    for (let n = 0; n <= PROGRAM_TEAM_CACHE_LIMIT; n++) {
      await access.allows(`p${n}`, 7);
    }
    await access.allows('p0', 7);
    expect(findUnique).toHaveBeenCalledTimes(PROGRAM_TEAM_CACHE_LIMIT + 2);
  });
});

describe('program team metadata', () => {
  it('falls back to Object when dependencies are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./program-team-access', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const interceptor = require('./program-team.interceptor') as {
        ProgramTeamInterceptor: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          interceptor.ProgramTeamInterceptor,
        ),
      ).toEqual([Object]);
    });
    jest.dontMock('./program-team-access');
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const access = require('./program-team-access') as {
        ProgramTeamAccess: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', access.ProgramTeamAccess),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../auth/pompeii.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});
