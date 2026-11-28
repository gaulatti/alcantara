import { Logger } from '@nestjs/common';
import { ProgramTeamAccess } from './program-team-access';

// The team a row records for its program (gaulatti/alcantara#122), read through the program team check's cache.
describe('ProgramTeamAccess.teamOf', () => {
  const access = (findUnique: jest.Mock) =>
    new ProgramTeamAccess({ program: { findUnique } } as never, { teamId: 3 } as never, { recordProgramTeamCheck: jest.fn() } as never);

  it("answers the program's team, and reads it once for a second answer", async () => {
    const findUnique = jest.fn(async () => ({ teamId: 7 }));
    const teams = access(findUnique);
    expect(await teams.teamOf(' news ')).toBe(7);
    expect(await teams.teamOf('news')).toBe(7);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { programId: 'news' }, select: { teamId: true } });
  });

  it('answers null for a program with no row, no team or team 0, and for a lookup that failed', async () => {
    expect(await access(jest.fn(async () => null)).teamOf('gone')).toBeNull();
    expect(await access(jest.fn(async () => ({ teamId: null }))).teamOf('unowned')).toBeNull();
    expect(await access(jest.fn(async () => ({ teamId: 0 }))).teamOf('local')).toBeNull();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await access(jest.fn(async () => Promise.reject(new TypeError('db down')))).teamOf('news')).toBeNull();
    warn.mockRestore();
  });
});
