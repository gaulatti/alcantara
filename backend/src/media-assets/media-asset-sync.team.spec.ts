import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from './media-asset-sync';

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

  it('fills the team of an asset that has none when its row is synced again', async () => {
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.media.create({
          data: { name: name(), imageUrl: url() },
        });
        const id = await syncImageAsset(tx, row);
        await expect(teams(tx, [id])).resolves.toEqual([null]);
        await syncImageAsset(tx, { ...row, assetId: id, teamId: 7 });
        await expect(teams(tx, [id])).resolves.toEqual([7]);
        // A row without a team never clears an asset's.
        await syncImageAsset(tx, { ...row, assetId: id, teamId: null });
        await expect(teams(tx, [id])).resolves.toEqual([7]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
