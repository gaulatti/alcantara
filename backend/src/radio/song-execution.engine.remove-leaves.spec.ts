import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SongExecutionEngine } from './song-execution.engine';
import {
  activeProgramSongLeafId,
  advanceProgramSongSequence,
  normalizeProgramSongSequence,
} from './song-sequence.utils';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';

/**
 * gaulatti/alcantara#327: removing leaves from a live playlist never rewrites the cursor from an
 * old read, never touches another field, and writes only if the row did not move.
 */
const leaf = (id: string, songId: number) => ({
  id,
  kind: 'preset' as const,
  songId,
  highRotation: songId === 2,
  artist: `Artist ${songId}`,
  title: `Title ${songId}`,
  coverUrl: `https://example.test/${songId}.jpg`,
  audioUrl: `https://example.test/${songId}.mp3`,
});

const stored = () => ({
  mode: 'autoplay' as const,
  intervalMs: 500,
  loop: true,
  startedAt: 1_000,
  activeItemId: 'a',
  items: [
    leaf('a', 1),
    leaf('b', 2),
    {
      id: 'block',
      kind: 'sequence' as const,
      label: 'Block',
      sequence: {
        mode: 'autoplay' as const,
        intervalMs: 500,
        loop: true,
        startedAt: 0,
        activeItemId: null,
        items: [leaf('c', 3), leaf('d', 4)],
      },
    },
    leaf('e', 5),
  ],
});

function harness(
  opts: { updateCounts?: number[]; row?: Record<string, unknown> | null } = {},
) {
  let row: Record<string, unknown> | null =
    opts.row === undefined
      ? {
          programId: 'radio-1',
          type: 'radio',
          songSequence: stored(),
          songQueue: [
            { id: 'q1', itemId: 'b', enqueuedAt: 1 },
            { id: 'q2', itemId: 'e', enqueuedAt: 2 },
          ],
          updatedAt: new Date(1),
        }
      : opts.row;
  const counts = [...(opts.updateCounts ?? [])];
  let version = 1;
  const prisma = {
    programState: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(row && { ...row })),
      updateMany: jest
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { updatedAt: Date }; data: object }) => {
            const forced = counts.shift();
            if (forced === 0) return Promise.resolve({ count: 0 });
            if (
              !row ||
              where.updatedAt.getTime() !== (row.updatedAt as Date).getTime()
            )
              return Promise.resolve({ count: 0 });
            version += 1;
            row = { ...row, ...data, updatedAt: new Date(version) };
            return Promise.resolve({ count: 1 });
          },
        ),
    },
  };
  const metrics = new Proxy({}, { get: () => jest.fn() });
  const engine = new SongExecutionEngine(
    {} as unknown as RadioService,
    { isClockedLogRunning: () => true } as unknown as FlightService,
    prisma as unknown as PrismaService,
    {} as unknown as NowPlayingPublisherService,
    metrics as unknown as RadioMetricsService,
  );
  return { engine, prisma, stored: () => row };
}

const remove = (
  h: ReturnType<typeof harness>,
  ids: string[],
  options: { keepRotation?: boolean; dryRun?: boolean } = {},
) =>
  h.engine.removeSongLeaves('radio-1', ids, {
    keepRotation: options.keepRotation === true,
    dryRun: options.dryRun === true,
  });

describe('SongExecutionEngine.removeSongLeaves (#327)', () => {
  it('removes a top-level and a nested leaf and changes nothing else as stored', async () => {
    const h = harness();
    const result = await remove(h, ['b', 'd']);

    expect(result.removed.map((l) => l.id)).toEqual(['b', 'd']);
    expect([result.before, result.after]).toEqual([5, 3]);
    const expected = stored();
    expected.items = [
      expected.items[0],
      {
        ...expected.items[2],
        sequence: {
          ...(expected.items[2] as any).sequence,
          items: [leaf('c', 3)],
        },
      } as any,
      expected.items[3],
    ];
    expect((h.stored() as any).songSequence).toEqual(expected);
  });

  it('filters the queue and keeps the entries of the leaves that stay', async () => {
    const h = harness();
    const result = await remove(h, ['b']);
    expect(result.songQueue.map((entry) => entry.itemId)).toEqual(['e']);
    expect(((h.stored() as any).songQueue as unknown[]).length).toBe(1);
  });

  it('refuses an unknown id and writes nothing', async () => {
    const h = harness();
    await expect(remove(h, ['b', 'nope'])).rejects.toThrow(
      /Unknown leaf id\(s\): nope/,
    );
    expect(h.prisma.programState.updateMany).not.toHaveBeenCalled();
  });

  it('names at most five unknown ids', async () => {
    const h = harness();
    await expect(
      remove(h, ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']),
    ).rejects.toThrow(/x1, x2, x3, x4, x5 and 2 more/);
  });

  // Walk part 5 (GM): the cursor names the song on air or last aired, and the engine plays the one after it. Moving it
  // forward onto the successor skipped that successor; it goes back to the nearest kept leaf instead (wrapping in a
  // loop), so the successor still airs next.
  it('refuses the active leaf, and with keep_rotation moves the cursor back so its successor still airs', async () => {
    const refused = harness();
    await expect(remove(refused, ['a'])).rejects.toThrow(/active leaf/);
    expect(refused.prisma.programState.updateMany).not.toHaveBeenCalled();

    const h = harness();
    const result = await remove(h, ['a'], { keepRotation: true });
    // "a" is first in a loop: the leaf before it is the last one, "e".
    expect(result.cursorMovedTo).toBe('e');
    expect((h.stored() as any).songSequence.activeItemId).toBe('e');
    // What the engine plays after that cursor is the removed leaf's successor.
    const after = normalizeProgramSongSequence(
      (h.stored() as any).songSequence,
    )!;
    advanceProgramSongSequence(after, 'e');
    expect(activeProgramSongLeafId(after)).toBe('b');
    expect(
      (h.stored() as any).songSequence.items.map((i: { id: string }) => i.id),
    ).toEqual(['b', 'block', 'e']);
  });

  it('skips removed neighbours: the successor that airs is the next kept leaf', async () => {
    const h = harness();
    const result = await remove(h, ['a', 'b'], { keepRotation: true });
    expect(result.cursorMovedTo).toBe('e');
    const after = normalizeProgramSongSequence(
      (h.stored() as any).songSequence,
    )!;
    advanceProgramSongSequence(after, 'e');
    expect(activeProgramSongLeafId(after)).toBe('c');
  });

  it('moves a cued cursor forward and keeps it cued: that song has not aired', async () => {
    const row = {
      programId: 'radio-1',
      type: 'radio',
      songSequence: { ...stored(), activeItemId: 'b', cuedItemId: 'b' },
      songQueue: [],
      updatedAt: new Date(1),
    };
    const h = harness({ row });
    const result = await remove(h, ['b'], { keepRotation: true });
    expect(result.cursorMovedTo).toBe('c');
    expect((h.stored() as any).songSequence).toMatchObject({
      activeItemId: 'block',
      // The leaf inside the block, so the block's other songs do not carry the mark.
      cuedItemId: 'c',
    });
  });

  it('moves the cursor the engine holds the same way, never to the first song', async () => {
    const h = harness();
    h.engine.handleSequenceUpdated('radio-1', {
      ...stored(),
      activeItemId: 'e',
    });
    await remove(h, ['e'], { keepRotation: true });
    const live = (h.engine as any).states.get('radio-1').sequence;
    expect(live.activeItemId).toBe('block');
    expect(activeProgramSongLeafId(live)).toBe('d');
  });

  // A Play Next or catalog song on air never moved the cursor: the cursor row has not aired.
  it.each([
    ['a Play Next song', { queueEntryId: 'q9', itemId: 'e' }],
    ['a catalog pick', { queueEntryId: null, itemId: 'catalog:9' }],
  ])(
    'moves a pending cursor forward under %s, never back to an aired song',
    async (_name, song) => {
      const h = harness();
      h.engine.handleSequenceUpdated('radio-1', {
        ...stored(),
        activeItemId: 'b',
      });
      (h.engine as any).states.get('radio-1').activeSong = song;
      const result = await remove(h, ['b'], { keepRotation: true });
      expect(result.cursorMovedTo).toBe('c');
      expect(result.songSequence.cuedItemId).toBe('c');
    },
  );

  it('plays the cued song when the removed song on air ends, not the one after it', () => {
    const h = harness();
    const left = {
      ...stored(),
      loop: false,
      items: stored().items.slice(1),
      activeItemId: 'b',
      cuedItemId: 'b',
    };
    const { next, hasSuccessor } = (h.engine as any).sequenceAfterEnd(left, {
      itemId: 'a',
      queueEntryId: null,
    });
    expect(hasSuccessor).toBe(true);
    expect(activeProgramSongLeafId(next)).toBe('b');
  });

  it('refuses when no leaf is left to move the rotation to', async () => {
    const row = {
      programId: 'radio-1',
      type: 'radio',
      songSequence: {
        ...stored(),
        loop: true,
        items: [leaf('a', 1)],
        activeItemId: 'a',
      },
      songQueue: [],
      updatedAt: new Date(1),
    };
    const h = harness({ row });
    await expect(remove(h, ['a'], { keepRotation: true })).rejects.toThrow(
      /No leaf is left/,
    );
  });

  it('lets the last leaf of a playlist that does not loop go: the cursor goes back to the leaf before it', async () => {
    const row = {
      programId: 'radio-1',
      type: 'radio',
      songSequence: {
        ...stored(),
        loop: false,
        items: [leaf('a', 1), leaf('b', 2)],
        activeItemId: 'b',
      },
      songQueue: [],
      updatedAt: new Date(1),
    };
    const h = harness({ row });
    const result = await remove(h, ['b'], { keepRotation: true });
    // The leaf before it has aired: nothing follows, so the rotation ends after it.
    expect(result.cursorMovedTo).toBe('a');
    expect(
      (h.stored() as any).songSequence.items.map((i: { id: string }) => i.id),
    ).toEqual(['a']);
  });

  it('a dry run reports the leaves and counts and writes nothing', async () => {
    const h = harness();
    const result = await remove(h, ['b', 'c'], { dryRun: true });
    expect(result.removed.map((l) => l.id)).toEqual(['b', 'c']);
    expect([result.before, result.after]).toEqual([5, 3]);
    expect(h.prisma.programState.updateMany).not.toHaveBeenCalled();
    expect((h.stored() as any).songSequence).toEqual(stored());
  });

  it('keeps the cursor the engine holds when a song ends between the read and the write', async () => {
    const h = harness();
    h.engine.handleSequenceUpdated('radio-1', stored());
    // The engine advances to leaf "e" after the row was read and before it is written.
    h.prisma.programState.updateMany.mockImplementationOnce(
      ({ data }: { data: object }) => {
        const live = (h.engine as any).states.get('radio-1');
        live.sequence.activeItemId = 'e';
        live.sequence.startedAt = 9_999;
        (h as any).wrote = data;
        return Promise.resolve({ count: 1 });
      },
    );
    const result = await remove(h, ['b']);
    const live = (h.engine as any).states.get('radio-1').sequence;
    expect(live.activeItemId).toBe('e');
    expect(live.startedAt).toBe(9_999);
    expect(live.items.map((i: { id: string }) => i.id)).toEqual([
      'a',
      'block',
      'e',
    ]);
    expect(result.songSequence.activeItemId).toBe('e');
  });

  it('uses the cursor the engine holds, not the stored one, as the base', async () => {
    const h = harness();
    const moved = { ...stored(), activeItemId: 'e', startedAt: 5_000 };
    h.engine.handleSequenceUpdated('radio-1', moved);
    await remove(h, ['b']);
    expect((h.stored() as any).songSequence.activeItemId).toBe('e');
    expect((h.stored() as any).songSequence.startedAt).toBe(5_000);
  });

  it('re-reads and retries when the row moved first, and gives up with a conflict', async () => {
    const retried = harness({ updateCounts: [0] });
    await remove(retried, ['b']);
    expect(retried.prisma.programState.updateMany).toHaveBeenCalledTimes(2);

    const stuck = harness({ updateCounts: [0, 0, 0, 0] });
    await expect(remove(stuck, ['b'])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(stuck.prisma.programState.updateMany).toHaveBeenCalledTimes(4);
    expect((stuck.stored() as any).songSequence).toEqual(stored());
  });

  it('refuses a program that does not exist or has no playlist', async () => {
    await expect(remove(harness({ row: null }), ['b'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const empty = harness({
      row: {
        programId: 'radio-1',
        type: 'radio',
        songSequence: null,
        songQueue: [],
        updatedAt: new Date(1),
      },
    });
    await expect(remove(empty, ['b'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // The engine moved onto a song while the row that removes every song was being written: nothing is left to move
  // the live cursor to, and the removal still goes through.
  it('lets the removal reset a live cursor that has nowhere to go', async () => {
    const h = harness({
      row: {
        programId: 'radio-1',
        type: 'radio',
        // Manual: an automatic rotation with no cursor is started at its first song when the engine takes it.
        songSequence: { ...stored(), mode: 'manual', activeItemId: null },
        songQueue: [],
        updatedAt: new Date(1),
      },
    });
    h.engine.handleSequenceUpdated('radio-1', {
      ...stored(),
      mode: 'manual',
      activeItemId: null,
    });
    h.prisma.programState.updateMany.mockImplementationOnce(() => {
      (h.engine as any).states.get('radio-1').sequence.activeItemId = 'a';
      return Promise.resolve({ count: 1 });
    });
    const result = await remove(h, ['a', 'b', 'c', 'd', 'e']);
    expect(result.removed).toHaveLength(5);
    const live = (h.engine as any).states.get('radio-1').sequence;
    expect(activeProgramSongLeafId(live)).toBeNull();
  });

  // Cued on the last song of a rotation that does not loop: nothing follows it, so the cursor is left empty.
  it('leaves no cursor when the cued last song of a rotation that does not loop is removed', async () => {
    const h = harness({
      row: {
        programId: 'radio-1',
        type: 'radio',
        songSequence: {
          ...stored(),
          loop: false,
          activeItemId: 'e',
          cuedItemId: 'e',
        },
        songQueue: [],
        updatedAt: new Date(1),
      },
    });
    const result = await remove(h, ['e'], { keepRotation: true });
    expect(result.cursorMovedTo).toBeNull();
    expect(activeProgramSongLeafId(result.songSequence)).not.toBe('e');
  });

  // A block with no songs has no leaf to cue: the cursor rests on it and nothing is marked.
  it('marks nothing cued when the cursor moves onto an empty block', async () => {
    const h = harness({
      row: {
        programId: 'radio-1',
        type: 'radio',
        songSequence: {
          ...stored(),
          activeItemId: 'a',
          cuedItemId: 'a',
          items: [
            leaf('a', 1),
            {
              id: 'empty',
              kind: 'sequence',
              label: 'Empty',
              sequence: {
                mode: 'autoplay',
                loop: true,
                activeItemId: null,
                items: [],
              },
            },
            leaf('e', 5),
          ],
        },
        songQueue: [],
        updatedAt: new Date(1),
      },
    });
    const result = await remove(h, ['a'], { keepRotation: true });
    expect(result.cursorMovedTo).toBeNull();
    expect(result.songSequence.activeItemId).toBe('empty');
    // The old mark names the removed song and is not moved to anything.
    expect(result.songSequence.cuedItemId).not.toBe('empty');
  });
});
