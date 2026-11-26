import { Prisma } from '@prisma/client';

export const MEDIA_ASSET_TEAM_FILL_BATCH = 500;

/** Every row a mirrored asset takes its team from. */
const OWNERS = [
  ['"Media"', '"assetId"'],
  ['"Instant"', '"assetId"'],
  ['"Song"', '"assetId"'],
  ['"Song"', '"coverAssetId"'],
  ['"Stinger"', '"assetId"'],
] as const;

/**
 * Gives each asset with no team the team of the row it mirrors
 * (gaulatti/alcantara#122), and returns how many it filled. An asset that has a
 * team is never changed. Each statement updates at most `batch` rows and commits
 * on its own, so a large backlog holds no long lock during boot.
 */
export async function fillMediaAssetTeams(
  prisma: Pick<Prisma.TransactionClient, '$executeRaw'>,
  batch = MEDIA_ASSET_TEAM_FILL_BATCH,
): Promise<number> {
  let filled = 0;
  for (const [table, column] of OWNERS) {
    let updated: number;
    do {
      updated = await prisma.$executeRaw(Prisma.sql`
        UPDATE "MediaAsset" SET "teamId" = owner."teamId"
        FROM (
          SELECT a."id", r."teamId" FROM "MediaAsset" a
          JOIN ${Prisma.raw(table)} r ON r.${Prisma.raw(column)} = a."id"
          WHERE a."teamId" IS NULL AND r."teamId" > 0
          LIMIT ${batch}
        ) AS owner
        WHERE "MediaAsset"."id" = owner."id" AND "MediaAsset"."teamId" IS NULL`);
      filled += updated;
    } while (updated > 0);
  }
  return filled;
}
