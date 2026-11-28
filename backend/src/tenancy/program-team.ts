import type { PrismaService } from '../prisma.service';

/**
 * A program's team, read for scoping its rows (gaulatti/alcantara#122): its `Program` row's `teamId`, or null when it
 * has no row or no team. It reads the database each time and lets a failed read throw, so each caller keeps its own
 * handling (refuse, count, or fall back); ProgramTeamAccess.teamOf is the cached, never-failing form for a check.
 * It lives in the tenancy module, the one place allowed to read a tenant model with the unscoped client.
 */
export async function readProgramTeam(
  prisma: PrismaService,
  programId: string,
): Promise<number | null> {
  const program = await prisma.program.findUnique({
    where: { programId },
    select: { teamId: true },
  });
  return program?.teamId ?? null;
}
