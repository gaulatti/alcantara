import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { PrismaService } from '../prisma.service';
import { ArtistLabelsService } from './artist-labels.service';

interface Row {
  id: number;
  artistKey: string;
  teamId: number | null;
  artist: string;
  labelId: string;
}

/** An in-memory stand-in for the two tables the service reads and writes. */
function harness(
  options: { createError?: Error; labels?: Record<string, number | null> } = {},
) {
  const labels: Record<string, number | null> = options.labels ?? {
    'label-a': null,
    'label-b': null,
    'team-7-label': 7,
    'team-9-label': 9,
  };
  const rows: Row[] = [];
  let nextId = 1;
  const matches =
    (where: { teamId?: number | null; artistKey?: string }) => (row: Row) =>
      (where.teamId === undefined || row.teamId === where.teamId) &&
      (where.artistKey === undefined || row.artistKey === where.artistKey);
  const create = jest.fn(({ data }: { data: Omit<Row, 'id'> }) => {
    if (options.createError) return Promise.reject(options.createError);
    const row = { id: nextId++, ...data };
    rows.push(row);
    return Promise.resolve(row);
  });
  const prisma = {
    artistLabel: {
      findMany: jest.fn(({ where }: { where: object }) =>
        Promise.resolve(
          rows
            .filter(matches(where))
            .sort((a, b) => a.artistKey.localeCompare(b.artistKey)),
        ),
      ),
      findFirst: jest.fn(({ where }: { where: object }) =>
        Promise.resolve(rows.find(matches(where)) ?? null),
      ),
      create,
      update: jest.fn(
        ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
          Object.assign(rows.find((row) => row.id === where.id)!, data);
          return Promise.resolve();
        },
      ),
      updateMany: jest.fn(
        ({ where, data }: { where: object; data: Partial<Row> }) => {
          rows
            .filter(matches(where))
            .forEach((row) => Object.assign(row, data));
          return Promise.resolve();
        },
      ),
      deleteMany: jest.fn(({ where }: { where: object }) => {
        const keep = rows.filter((row) => !matches(where)(row));
        rows.splice(0, rows.length, ...keep);
        return Promise.resolve();
      }),
    },
    mediaLabel: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id in labels
            ? { id: where.id, teamId: labels[where.id] }
            : null,
        ),
      ),
    },
  };
  const metrics = { recordArtistLabelWrite: jest.fn() };
  const service = new ArtistLabelsService(
    prisma as unknown as PrismaService,
    metrics as unknown as ManagedMetricsService,
  );
  return { service, prisma, metrics, rows };
}

describe('ArtistLabelsService', () => {
  it('finds the label of an artist whatever its case or outer spaces, and returns null once cleared', async () => {
    const { service, metrics } = harness();
    await expect(service.set(7, 'ROB', 'label-a')).resolves.toEqual({
      artistKey: 'rob',
      artist: 'ROB',
      labelId: 'label-a',
    });
    await expect(service.artistLabelFor(7, ' rob ')).resolves.toBe('label-a');
    await expect(service.artistLabelFor(7, 'Someone else')).resolves.toBeNull();
    await expect(service.set(7, 'rob', null)).resolves.toEqual({
      artistKey: 'rob',
      artist: 'rob',
      labelId: null,
    });
    await expect(service.artistLabelFor(7, 'ROB')).resolves.toBeNull();
    expect(metrics.recordArtistLabelWrite.mock.calls).toEqual([
      ['set'],
      ['cleared'],
    ]);
  });

  it('replaces the link of an artist, keeping one row and the last spelling', async () => {
    const { service, rows, prisma } = harness();
    await service.set(7, 'Rob', 'label-a');
    await service.set(7, 'ROB', 'label-b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artist: 'ROB', labelId: 'label-b' });
    expect(prisma.artistLabel.create).toHaveBeenCalledTimes(1);
    await expect(service.list(7)).resolves.toEqual([
      { artistKey: 'rob', artist: 'ROB', labelId: 'label-b' },
    ]);
  });

  it('keeps each team to its own links, and stores no team for team 0', async () => {
    const { service, rows } = harness();
    await service.set(7, 'Rob', 'label-a');
    await service.set(9, 'Rob', 'label-b');
    await service.set(0, 'Rob', 'label-a');
    expect(rows.map((row) => row.teamId)).toEqual([7, 9, null]);
    await expect(service.artistLabelFor(7, 'rob')).resolves.toBe('label-a');
    await expect(service.artistLabelFor(9, 'rob')).resolves.toBe('label-b');
    await expect(service.list(0)).resolves.toHaveLength(1);
    await service.set(7, 'rob', null);
    await expect(service.artistLabelFor(9, 'rob')).resolves.toBe('label-b');
  });

  it('refuses a label of another team or one that does not exist, and counts the refusal', async () => {
    const { service, metrics, rows } = harness();
    await expect(service.set(7, 'Rob', 'team-9-label')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.set(7, 'Rob', 'missing')).rejects.toThrow(
      'The label does not exist for this team',
    );
    await expect(service.set(0, 'Rob', 'team-7-label')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.set(7, 'Rob', 'team-7-label')).resolves.toMatchObject({
      labelId: 'team-7-label',
    });
    expect(rows).toHaveLength(1);
    expect(
      metrics.recordArtistLabelWrite.mock.calls.filter(
        ([result]) => result === 'rejected',
      ),
    ).toHaveLength(3);
  });

  it('refuses an artist or label id of the wrong shape', async () => {
    const { service, metrics, prisma } = harness();
    for (const [artist, label] of [
      [undefined, 'label-a'],
      ['   ', 'label-a'],
      ['x'.repeat(201), 'label-a'],
      [42, 'label-a'],
      ['Rob', undefined],
      ['Rob', ''],
      ['Rob', 5],
    ] as const)
      await expect(service.set(7, artist, label)).rejects.toThrow(
        BadRequestException,
      );
    expect(metrics.recordArtistLabelWrite).toHaveBeenCalledTimes(7);
    expect(prisma.mediaLabel.findUnique).not.toHaveBeenCalled();
    await expect(
      service.set(7, 'x'.repeat(200), 'label-a'),
    ).resolves.toBeTruthy();
  });

  it('lets a concurrent write for the same artist win the index and replaces it', async () => {
    const { service, rows, prisma } = harness({
      createError: new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    });
    rows.push({
      id: 99,
      artistKey: 'rob',
      teamId: 7,
      artist: 'Rob',
      labelId: 'label-a',
    });
    // Hide the row from the first lookup, as a write that lands after it would.
    prisma.artistLabel.findFirst.mockResolvedValueOnce(null);
    await service.set(7, 'ROB', 'label-b');
    expect(prisma.artistLabel.updateMany).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ artist: 'ROB', labelId: 'label-b' });
  });

  it('surfaces any other failure to create the link', async () => {
    const { service, metrics } = harness({ createError: new Error('down') });
    await expect(service.set(7, 'Rob', 'label-a')).rejects.toThrow('down');
    expect(metrics.recordArtistLabelWrite).not.toHaveBeenCalled();
    const known = harness({
      createError: new Prisma.PrismaClientKnownRequestError('other', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    });
    await expect(known.service.set(7, 'Rob', 'label-a')).rejects.toThrow(
      'other',
    );
  });
});
