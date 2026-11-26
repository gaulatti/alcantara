import { ProgramTeamAccess } from './program-team-access';
import { programIdsOf, ProgramTeamGuard } from './program-team.guard';

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

describe('ProgramTeamGuard', () => {
  it('does not check what is not HTTP', async () => {
    const access = { allows: jest.fn() };
    const guard = new ProgramTeamGuard(access as never);
    await expect(
      guard.canActivate({ getType: () => 'rpc' } as never),
    ).resolves.toBe(true);
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

describe('program team metadata', () => {
  it('falls back to Object when dependencies are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./program-team-access', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const guard = require('./program-team.guard') as {
        ProgramTeamGuard: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', guard.ProgramTeamGuard),
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
