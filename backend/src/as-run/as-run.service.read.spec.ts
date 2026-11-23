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

describe('AsRunService.countExportRows', () => {
  // #237: without `from` the window is the 31 days before `to` (or now).
  const NOW = new Date('2026-11-21T00:00:00Z');
  const DEFAULT_FROM = new Date('2026-10-21T00:00:00Z');
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  const count = async (query: Record<string, string>) => {
    const prisma = { asRunRecord: { count: jest.fn().mockResolvedValue(7) } };
    const service = new AsRunService(prisma as unknown as PrismaService);
    const n = await service.countExportRows('p1', query);
    return { n, where: prisma.asRunRecord.count.mock.calls[0][0].where };
  };

  it('counts every record of a csv window, open ends included', async () => {
    expect(await count({})).toEqual({
      n: 7,
      where: { programId: 'p1', at: { gte: DEFAULT_FROM } },
    });
    const { where } = await count({
      from: '2026-11-10T00:00:00Z',
      to: '2026-11-11T00:00:00Z',
      format: 'CSV',
    });
    expect(where).toEqual({
      programId: 'p1',
      at: {
        gte: new Date('2026-11-10T00:00:00Z'),
        lte: new Date('2026-11-11T00:00:00Z'),
      },
    });
    expect((await count({ to: '2026-11-11T00:00:00Z' })).where.at).toEqual({
      gte: new Date('2026-10-11T00:00:00Z'),
      lte: new Date('2026-11-11T00:00:00Z'),
    });
  });

  it('counts the ended records of the inferred filter for soundexchange', async () => {
    const base = { format: 'soundexchange' };
    expect((await count(base)).where).toEqual({
      programId: 'p1',
      at: { gte: DEFAULT_FROM },
      state: 'ended',
    });
    expect((await count({ ...base, inferred: 'ONLY' })).where).toMatchObject({
      state: 'ended',
      inferred: true,
    });
    expect((await count({ ...base, inferred: 'exclude' })).where).toMatchObject(
      { state: 'ended', inferred: false },
    );
  });

  it('refuses a bad date as export does', async () => {
    await expect(count({ from: 'nope' })).rejects.toThrow('Invalid from date');
  });
});

// gaulatti/alcantara#237: the export and the royalty summary read in pages.
describe('AsRunService paged reads', () => {
  // A table of `total` rows that answers findMany like Prisma: ordered by
  // (at, id), `take` rows after the cursor.
  function pagedTable(total: number, make: (id: number) => object) {
    const takes: number[] = [];
    const findMany = jest.fn(
      (args: { take?: number; cursor?: { id: number }; skip?: number }) => {
        takes.push(args.take ?? Number.POSITIVE_INFINITY);
        const start = args.cursor ? args.cursor.id + (args.skip ?? 0) : 1;
        const end = Math.min(total, start + (args.take ?? total) - 1);
        const page: object[] = [];
        for (let id = start; id <= end; id += 1) page.push(make(id));
        return Promise.resolve(page);
      },
    );
    return { findMany, takes };
  }

  it('exports 50,000 rows in pages of 1,000 with every row present', async () => {
    const table = pagedTable(50_000, (id) =>
      row({ id, songId: (id % 40) + 1, at: new Date(1_700_000_000_000 + id) }),
    );
    const songs = jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
      Promise.resolve(
        where.id.in.map((id) => ({ id, title: `T${id}`, artist: `A${id}` })),
      ),
    );
    const service = new AsRunService({
      asRunRecord: { findMany: table.findMany },
      song: { findMany: songs },
    } as unknown as PrismaService);

    const csv = await service.exportCsv(
      'p1',
      new Date('2023-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );

    expect(csv.split('\n')).toHaveLength(50_001);
    expect(table.findMany).toHaveBeenCalledTimes(51);
    expect(Math.max(...table.takes)).toBe(1000);
    // Each song is resolved once, not once per page.
    expect(songs.mock.calls.flatMap(([args]) => args.where.id.in)).toHaveLength(
      40,
    );
  });

  it('summarises 120,000 ended rows completely while holding one row per recording', async () => {
    const table = pagedTable(120_000, (id) =>
      row({ id, songId: (id % 300) + 1, state: 'ended' }),
    );
    const songFind = jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
      Promise.resolve(
        where.id.in.map((id) => ({ id, title: `T${id}`, artist: `A${id}` })),
      ),
    );
    const service = new AsRunService({
      asRunRecord: { findMany: table.findMany },
      song: { findMany: songFind },
      mediaAsset: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);

    const performances = await service.summarizePerformances(
      'p1',
      new Date('2026-08-21T00:00:00Z'),
      new Date('2026-11-21T00:00:00Z'),
    );

    expect(performances).toHaveLength(300);
    expect(performances.reduce((sum, p) => sum + p.count, 0)).toBe(120_000);
    expect(table.findMany).toHaveBeenCalledTimes(121);
    expect(Math.max(...table.takes)).toBe(1000);
    // Songs are looked up for the distinct recordings only.
    expect(songFind.mock.calls[0][0].where.id.in).toHaveLength(300);
  });
});
