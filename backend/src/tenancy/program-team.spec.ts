import { readProgramTeam } from './program-team';

// A program's team for scoping its rows (gaulatti/alcantara#122).
describe('readProgramTeam', () => {
  it("reads the program's team, null when it has no row or no team, and lets a failed read throw", async () => {
    const findUnique = jest.fn();
    const prisma = { program: { findUnique } } as never;
    findUnique.mockResolvedValueOnce({ teamId: 7 });
    expect(await readProgramTeam(prisma, 'news')).toBe(7);
    expect(findUnique).toHaveBeenCalledWith({
      where: { programId: 'news' },
      select: { teamId: true },
    });
    findUnique.mockResolvedValueOnce({ teamId: null });
    expect(await readProgramTeam(prisma, 'news')).toBeNull();
    findUnique.mockResolvedValueOnce(null);
    expect(await readProgramTeam(prisma, 'gone')).toBeNull();
    findUnique.mockRejectedValueOnce(new TypeError('db down'));
    await expect(readProgramTeam(prisma, 'news')).rejects.toThrow('db down');
  });
});
