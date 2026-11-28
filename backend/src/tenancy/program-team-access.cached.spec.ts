import { ProgramTeamAccess } from './program-team-access';

// gaulatti/alcantara#122: a write reads a program's team from the cache alone, and warms the cache in the background.

const build = (findUnique: jest.Mock) =>
  new ProgramTeamAccess(
    { program: { findUnique } } as any,
    { teamId: 0 } as any,
    { recordProgramTeamCheck: jest.fn() } as any,
  );

describe('cachedTeamOf and warmTeamOf', () => {
  it('reads nothing and returns null before any team is remembered', () => {
    const findUnique = jest.fn();
    const access = build(findUnique);
    expect(access.cachedTeamOf('p')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns the remembered team once a lookup has answered, and never reads the database for it', async () => {
    const findUnique = jest.fn(async () => ({ teamId: 7 }));
    const access = build(findUnique);
    await access.teamOf('p');
    findUnique.mockClear();
    expect(access.cachedTeamOf('p')).toBe(7);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null for a program with no team, and for team 0', async () => {
    const findUnique = jest.fn(async () => ({ teamId: 0 }));
    const access = build(findUnique);
    await access.teamOf('p');
    expect(access.cachedTeamOf('p')).toBeNull();
  });

  it('warms the cache in the background without waiting for the lookup', async () => {
    let answer!: (value: { teamId: number }) => void;
    const findUnique = jest.fn(
      () => new Promise<{ teamId: number }>((resolve) => (answer = resolve)),
    );
    const access = build(findUnique);
    expect(() => access.warmTeamOf('p')).not.toThrow();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(access.cachedTeamOf('p')).toBeNull();
    answer({ teamId: 9 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(access.cachedTeamOf('p')).toBe(9);
  });
});
