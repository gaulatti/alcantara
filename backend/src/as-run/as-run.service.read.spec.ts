/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
import { AsRunService } from './as-run.service';
import type { PrismaService } from '../prisma.service';

// gaulatti/alcantara#214: the window and per-song views the MCP read tools use.

const row = (over: Record<string, unknown>) => ({
  id: 1,
  programId: 'p1',
  songId: null,
  assetId: null,
  state: 'ended',
  at: new Date('2026-11-10T10:00:00.000Z'),
  createdAt: new Date('2026-11-10T10:00:00.000Z'),
  playbackRequestId: null,
  inferred: false,
  reviewFlag: null,
  endReason: null,
  actorPrincipalId: null,
  actorVia: null,
  actorClient: null,
  ...over,
});

function setup(records: unknown[]) {
  const prisma = {
    asRunRecord: { findMany: jest.fn().mockResolvedValue(records) },
    song: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 7, title: 'Seven', artist: 'Band' }]),
    },
    mediaAsset: {
      findMany: jest.fn().mockResolvedValue([{ id: 'a1', name: 'Clip' }]),
    },
  };
  return {
    prisma,
    service: new AsRunService(prisma as unknown as PrismaService),
  };
}

describe('AsRunService read views', () => {
  const from = new Date('2026-11-10T00:00:00.000Z');
  const to = new Date('2026-11-11T00:00:00.000Z');

  it('lists rows of a window oldest first, asking for one more than the limit', async () => {
    const { prisma, service } = setup([
      row({
        id: 1,
        songId: 7,
        inferred: true,
        endReason: 'stopped',
        actorPrincipalId: 'p-1',
        actorVia: 'mcp',
        actorClient: 'c',
      }),
      row({ id: 2 }),
    ]);
    const listed = await service.listRecords('p1', from, to, 1);
    expect(prisma.asRunRecord.findMany).toHaveBeenCalledWith({
      where: { programId: 'p1', at: { gte: from, lte: to } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: 2,
    });
    expect(listed.truncated).toBe(true);
    expect(listed.records).toEqual([
      expect.objectContaining({
        id: 1,
        songId: 7,
        title: 'Seven',
        artist: 'Band',
        inferred: true,
        endReason: 'stopped',
        actorPrincipalId: 'p-1',
        actorVia: 'mcp',
        actorClient: 'c',
      }),
    ]);
  });

  it('lists rows with no song without asking the catalog, and empty text for an unknown song', async () => {
    const none = setup([row({ id: 1 })]);
    const listed = await none.service.listRecords('p1', from, to, 5);
    expect(none.prisma.song.findMany).not.toHaveBeenCalled();
    expect(listed.truncated).toBe(false);
    expect(listed.records[0]).toMatchObject({ title: '', artist: '' });
    const unknown = setup([row({ id: 1, songId: 99, inferred: null })]);
    const again = await unknown.service.listRecords('p1', from, to, 5);
    expect(again.records[0]).toMatchObject({
      title: '',
      artist: '',
      inferred: false,
    });
  });

  it('counts performances by song, asset or record, with the title of a song or asset', async () => {
    const { service } = setup([
      row({ id: 1, songId: 7 }),
      row({ id: 2, songId: 7 }),
      row({ id: 3, assetId: 'a1' }),
      row({ id: 4 }),
    ]);
    expect(await service.summarizePerformances('p1', from, to)).toEqual([
      { songId: 7, assetId: null, artist: 'Band', title: 'Seven', count: 2 },
      { songId: null, assetId: 'a1', artist: '', title: 'Clip', count: 1 },
      { songId: null, assetId: null, artist: '', title: '', count: 1 },
    ]);
  });
});
