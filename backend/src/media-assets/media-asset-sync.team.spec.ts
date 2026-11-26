import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from './media-asset-sync';
import { fillMediaAssetTeams } from './media-asset-team-fill';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// Each writer of a mirrored asset stamps its row's team through the unscoped client, which is what the start-up
// reconciliation uses (gaulatti/alcantara#122). Every case is rolled back.
describe('media assets take the team of the row they mirror, against Postgres', () => {
  let prisma: PrismaService;
  const url = () => `https://media.test/${randomUUID()}`;
  const name = () => `team-stamp-${randomUUID()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  type Tx = Prisma.TransactionClient;
  const writers: Array<
    [string, (tx: Tx, teamId: number | null) => Promise<string[]>]
  > = [
    [
      'an image',
      async (tx, teamId) => {
        const row = await tx.media.create({
          data: { name: name(), imageUrl: url(), teamId },
        });
        return [await syncImageAsset(tx, row)];
      },
    ],
    [
      'an audio clip',
      async (tx, teamId) => {
        const row = await tx.instant.create({
          data: { name: name(), audioUrl: url(), teamId, position: 0 },
        });
        return [await syncAudioClipAsset(tx, row)];
      },
    ],
    [
      'a song and its cover',
      async (tx, teamId) => {
        const row = await tx.song.create({
          data: {
            artist: name(),
            title: 'song',
            audioUrl: url(),
            coverUrl: url(),
            teamId,
          },
        });
        return [await syncSongAsset(tx, row), `song-cover:${row.id}`];
      },
    ],
    [
      'a transition',
      async (tx, teamId) => {
        const row = await tx.stinger.create({
          data: { name: name(), videoUrl: url(), teamId },
        });
        return [await syncTransitionAsset(tx, row)];
      },
    ],
  ];

  const teams = async (tx: Tx, ids: string[]) =>
    (
      await tx.mediaAsset.findMany({
        where: { id: { in: ids } },
        select: { teamId: true },
      })
    ).map((asset) => asset.teamId);

  it.each(writers)('stamps the team on %s', async (_what, write) => {
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        const ids = await write(tx, 7);
        await expect(teams(tx, ids)).resolves.toEqual(ids.map(() => 7));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await expect(
      prisma.$transaction(async (tx) => {
        const ids = await write(tx, null);
        await expect(teams(tx, ids)).resolves.toEqual(ids.map(() => null));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('leaves the team of an existing asset to the fill', async () => {
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.media.create({
          data: { name: name(), imageUrl: url() },
        });
        const id = await syncImageAsset(tx, row);
        await syncImageAsset(tx, { ...row, assetId: id, teamId: 7 });
        await expect(teams(tx, [id])).resolves.toEqual([null]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('fills assets with no team from every kind of row, and never changes one that has a team', async () => {
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        const mirrored: string[] = [];
        for (const [, write] of writers) mirrored.push(...(await write(tx, 7)));
        await tx.mediaAsset.updateMany({
          where: { id: { in: mirrored } },
          data: { teamId: null },
        });
        const [kept, orphaned] = [
          await writers[0][1](tx, 7),
          await writers[0][1](tx, null),
        ];
        await tx.media.updateMany({
          where: { assetId: kept[0] },
          data: { teamId: 8 },
        });

        // A batch of one: every statement fills one row and the fill still finishes.
        await expect(
          fillMediaAssetTeams(tx, 1),
        ).resolves.toBeGreaterThanOrEqual(mirrored.length);
        await expect(teams(tx, mirrored)).resolves.toEqual(
          mirrored.map(() => 7),
        );
        await expect(teams(tx, kept)).resolves.toEqual([7]);
        await expect(teams(tx, orphaned)).resolves.toEqual([null]);
        await expect(fillMediaAssetTeams(tx)).resolves.toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('asks again until a statement fills nothing, with the batch of 500 by default', async () => {
    const statements: Prisma.Sql[] = [];
    const counts = [500, 12, 0];
    const total = await fillMediaAssetTeams({
      $executeRaw: (async (sql: Prisma.Sql) => {
        statements.push(sql);
        return counts.shift() ?? 0;
      }) as never,
    });
    expect(total).toBe(512);
    // Three statements for the first table, then one for each of the other four.
    expect(statements).toHaveLength(7);
    for (const statement of statements) {
      expect(statement.sql).toContain('LIMIT ?');
      expect(statement.values).toEqual([500]);
    }
  });
});
