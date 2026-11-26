import { ConflictException } from '@nestjs/common';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import {
  programSongSequenceVersion,
  ROTATION_CHANGED_MESSAGE,
} from '../radio/song-sequence-version';
import { normalizeProgramSongSequence } from '../radio/song-sequence.utils';
import { ProgramService } from './program.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

// A save of the rotation replaces all of it, so an operator's save must be made from the rotation now stored.
const leaf = (id: string) => ({
  id,
  kind: 'preset',
  title: id,
  artist: 'A',
  audioUrl: `https://media.example/${id}.mp3`,
  coverUrl: '',
});
const rotation = (...ids: string[]) => ({
  mode: 'manual',
  items: ids.map(leaf),
  activeItemId: ids[0] ?? null,
  startedAt: 1,
  loop: true,
});

describe('the version of a rotation', () => {
  const of = programSongSequenceVersion;

  it('changes with the playlist and the mode, not with the cursor', () => {
    const stored = rotation('a', 'b');
    expect(of({ ...stored, activeItemId: 'b', startedAt: 99 })).toBe(
      of(stored),
    );
    expect(of(rotation('a'))).not.toBe(of(stored));
    expect(of({ ...stored, mode: 'autoplay' })).not.toBe(of(stored));
    expect(of(null)).toBe(of(undefined));
    expect(of(null)).not.toBe(of(rotation()));
  });

  it('is the same on every read of a rotation stored without ids', () => {
    const unnamed = {
      items: [
        { title: 'One', artist: 'A' },
        'not an item',
        { kind: 'sequence', sequence: { items: [{ title: 'Two' }] } },
        { kind: 'sequence' },
      ],
    };
    const first = of(unnamed);
    jest.useFakeTimers({ now: Date.now() + 60_000 });
    expect(of(unnamed)).toBe(first);
    jest.useRealTimers();
    expect(of([])).toBe(of(null));
  });
});

describe('saving the rotation', () => {
  const build = (stored: unknown = rotation('a', 'b', 'c')) => {
    const row = {
      songSequence: stored,
      songQueue: [],
      audioMixer: null,
      type: 'tv',
      updatedAt: new Date(0),
    };
    const prisma = {
      programState: {
        findUnique: jest.fn(() => Promise.resolve({ ...row })),
        update: jest.fn(
          ({ data }: { data: { songSequence?: unknown } }) =>
            Promise.resolve({ ...row, ...data }) as Promise<unknown>,
        ),
      },
    };
    const metrics = { recordSongSequenceSave: jest.fn() };
    const service = new ProgramService(
      prisma as never,
      {} as never,
      {
        handleSequenceUpdated: jest.fn(),
        handleQueueUpdated: jest.fn(),
      } as never,
      metrics as never,
      undefined,
      noRecorder(),
    );
    jest
      .spyOn(service, 'broadcastUpdate' as never)
      .mockReturnValue({} as never);
    const save = (
      sequenceVersion: unknown,
      client: 'console' | 'mcp' = 'console',
      songSequence: unknown = rotation('a', 'b'),
    ) =>
      service.updateProgramAudioBus(
        {
          songSequence,
          ...(sequenceVersion === undefined ? {} : { sequenceVersion }),
        } as never,
        'show',
        client,
      );
    return { service, prisma, metrics, save, current: of(stored) };
  };
  const of = programSongSequenceVersion;
  const refused = async (result: Promise<unknown>) => {
    const error: unknown = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(ROTATION_CHANGED_MESSAGE);
  };

  it('writes a save made from the stored rotation, against the row it read, and answers the new version', async () => {
    const { save, prisma, metrics, current } = build();
    const saved = await save(current);
    expect(saved.sequenceVersion).toBe(of(rotation('a', 'b')));
    expect(prisma.programState.update.mock.calls[0][0]).toMatchObject({
      where: { programId: 'show', updatedAt: new Date(0) },
    });
    expect(metrics.recordSongSequenceSave).toHaveBeenCalledWith('versioned');
  });

  it.each([
    ['the version of another rotation', 'stale', 'refused_stale'],
    ['no version because its load failed', null, 'refused_missing'],
  ])('refuses %s and writes nothing', async (_, version, result) => {
    const { save, prisma, metrics } = build();
    await refused(save(version));
    expect(prisma.programState.update).not.toHaveBeenCalled();
    expect(metrics.recordSongSequenceSave).toHaveBeenCalledWith(result);
  });

  it('refuses an MCP save without a version', async () => {
    const { save, metrics } = build();
    await refused(save(undefined, 'mcp'));
    expect(metrics.recordSongSequenceSave).toHaveBeenCalledWith(
      'refused_missing',
    );
  });

  it('still takes a save from a console that sends none, but not one that would empty the rotation', async () => {
    const { save, prisma, metrics } = build();
    await save(undefined);
    expect(metrics.recordSongSequenceSave).toHaveBeenCalledWith('unversioned');
    expect(prisma.programState.update.mock.calls[0][0]).toMatchObject({
      where: { programId: 'show' },
    });
    for (const songSequence of [null, rotation(), rotation('z')])
      await refused(save(undefined, 'console', songSequence));
    expect(metrics.recordSongSequenceSave).toHaveBeenCalledWith(
      'refused_emptying',
    );
    expect(prisma.programState.update).toHaveBeenCalledTimes(1);
    // A rotation of two songs can still be cut to one.
    await build(rotation('a', 'b')).save(undefined, 'console', rotation('a'));
  });

  it('reads and checks again when the row changed under the save', async () => {
    const { save, prisma, metrics, current } = build();
    const gone = Object.assign(new Error('no row'), { code: 'P2025' });
    prisma.programState.update.mockRejectedValueOnce(gone);
    await save(current);
    expect(prisma.programState.findUnique).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 3; i += 1)
      prisma.programState.update.mockRejectedValueOnce(gone);
    await refused(save(current));
    expect(metrics.recordSongSequenceSave).toHaveBeenLastCalledWith(
      'refused_stale',
    );

    prisma.programState.update.mockRejectedValueOnce(new Error('database'));
    await expect(save(current)).rejects.toThrow('database');
  });

  it('leaves automation and a save of the mixer alone', async () => {
    const { service, metrics } = build();
    await service.updateProgramAudioBus({ songSequence: null }, 'show');
    await service.updateProgramAudioBus(
      { mixerSettings: {} },
      'show',
      'console',
    );
    expect(metrics.recordSongSequenceSave).not.toHaveBeenCalled();
  });
});

describe('a rotation the engine stores', () => {
  it('is sent with its version, which a Stop changes by leaving the mode manual', () => {
    const service = new ProgramService({} as never, {} as never, {} as never);
    const sent = jest
      .spyOn(service, 'broadcastUpdate' as never)
      .mockReturnValue({} as never);
    const playing = { ...rotation('a', 'b'), mode: 'autoplay' };
    const stopped = { ...playing, mode: 'manual', activeItemId: 'b' };
    const emit = (songSequence?: unknown) =>
      (
        service as unknown as { handleEngineEvent(event: unknown): void }
      ).handleEngineEvent({
        type: 'song_queue_update',
        programId: 'show',
        songQueue: [],
        ...(songSequence ? { songSequence } : {}),
      });

    emit(stopped);
    expect(sent).toHaveBeenLastCalledWith(
      'show',
      expect.objectContaining({
        sequenceVersion: programSongSequenceVersion(stopped),
      }),
    );
    expect(programSongSequenceVersion(stopped)).not.toBe(
      programSongSequenceVersion(playing),
    );
    emit();
    expect(sent.mock.calls.at(-1)![1]).not.toHaveProperty('sequenceVersion');
  });
});

// Walk part 4: a rotation that does not loop runs out and the engine stores it manual, with endedAt. The mode is part
// of the version, so the stored rotation is broadcast with its new version; endedAt, where the rotation stands, is not.
describe('a rotation that ran out', () => {
  const playing = { ...rotation('a', 'b'), mode: 'autoplay', loop: false };
  const ended = { ...playing, mode: 'manual', endedAt: 4_102_444_800_000 };

  it('keeps endedAt through normalising, leaves it out of the version, and reads a rotation without it as before', () => {
    expect(normalizeProgramSongSequence(ended)?.endedAt).toBe(4_102_444_800_000);
    for (const bad of [undefined, null, 'soon', Number.NaN, 0, -5])
      expect(normalizeProgramSongSequence({ ...ended, endedAt: bad })).not.toHaveProperty('endedAt');
    expect(programSongSequenceVersion(ended)).toBe(
      programSongSequenceVersion({ ...ended, endedAt: undefined }),
    );
    expect(programSongSequenceVersion(ended)).not.toBe(programSongSequenceVersion(playing));
  });

  it('is broadcast with its new version, and a save made from it right after the end is written', async () => {
    const service = new ProgramService({} as never, {} as never, {} as never);
    const sent = jest.spyOn(service, 'broadcastUpdate' as never).mockReturnValue({} as never);
    (service as unknown as { handleEngineEvent(event: unknown): void }).handleEngineEvent({
      type: 'song_queue_update',
      programId: 'show',
      songQueue: [],
      songSequence: ended,
    });
    const broadcast = (sent.mock.calls.at(-1) as unknown as unknown[])[1] as { sequenceVersion: string };
    expect(broadcast.sequenceVersion).toBe(programSongSequenceVersion(ended));

    // The desk turns Loop on from what it was sent: the save is written, not refused as stale.
    const row = { songSequence: ended, songQueue: [], audioMixer: null, type: 'radio', updatedAt: new Date(0) };
    const prisma = {
      programState: {
        findUnique: jest.fn(() => Promise.resolve({ ...row })),
        update: jest.fn(({ data }: { data: object }) => Promise.resolve({ ...row, ...data })),
      },
    };
    const saving = new ProgramService(
      prisma as never,
      {} as never,
      { handleSequenceUpdated: jest.fn(), handleQueueUpdated: jest.fn() } as never,
      { recordSongSequenceSave: jest.fn() } as never,
      undefined,
      noRecorder(),
    );
    jest.spyOn(saving, 'broadcastUpdate' as never).mockReturnValue({} as never);
    const saved = await saving.updateProgramAudioBus(
      { songSequence: { ...ended, loop: true }, sequenceVersion: broadcast.sequenceVersion } as never,
      'show',
      'console',
    );
    expect(prisma.programState.update).toHaveBeenCalledTimes(1);
    expect(saved.sequenceVersion).toBe(programSongSequenceVersion({ ...ended, loop: true }));
    expect(
      (prisma.programState.update.mock.calls[0][0] as { data: { songSequence: { endedAt?: number } } }).data
        .songSequence.endedAt,
    ).toBe(4_102_444_800_000);
  });
});

describe('the rotation save counter', () => {
  it('is exposed from 0 for each result and counts one', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordSongSequenceSave('refused_stale');
    const output = await metrics.render('');
    for (const [result, count] of [
      ['versioned', 0],
      ['unversioned', 0],
      ['refused_missing', 0],
      ['refused_stale', 1],
      ['refused_emptying', 0],
    ])
      expect(output).toContain(
        `alcantara_song_sequence_saves_total{result="${result}"} ${count}`,
      );
  });
});
