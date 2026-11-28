import { SongExecutionEngine } from './song-execution.engine';
import { CATALOG_ITEM_PREFIX } from './song-similarity.utils';

const leafOne = {
  id: 'song-1',
  kind: 'preset',
  title: 'Song one',
  artist: 'Artist one',
  coverUrl: 'https://example.test/1.jpg',
  audioUrl: 'https://example.test/1.mp3',
  durationMs: 1000,
  songId: 101,
};
const leafTwo = { ...leafOne, id: 'song-2', title: 'Song two', songId: 102 };

/** The proposal request the engine hands to the similarity service. */
interface ProposeRequest {
  currentSongId: number | null;
  currentArtist: string;
  leaves: { leaf: { id: string }; blocked: boolean }[];
}

/** One recorded `propose` call. */
type Call = [string, ProposeRequest];

/** The private engine surface these tests drive. */
interface SimilarityEngineInternals {
  resolveWithSimilarity(
    programId: string,
    state: Record<string, unknown>,
    sequence: unknown,
    favoriteCount: number,
    mode: 'shadow' | 'on',
    now: number,
  ): unknown;
  playNext(programId: string): boolean;
}

/** The slice of engine state the cycle-reset test seeds and reads back. */
interface StartState {
  sequence: unknown;
  queue: unknown[];
  queueBlocked: boolean;
  pendingRequestIds: Set<string>;
  pendingCycleReset: boolean;
  activeSong: { cycleReset?: boolean };
}

function sequence() {
  return {
    mode: 'autoplay',
    loop: true,
    intervalMs: 500,
    items: [{ ...leafOne }, { ...leafTwo, highRotation: true }],
  } as unknown;
}

/** A bare engine with only the collaborators the similarity path touches. */
function build() {
  const engine = Object.create(
    SongExecutionEngine.prototype,
  ) as SimilarityEngineInternals;
  const similarity = { propose: jest.fn(), recordDecision: jest.fn() };
  const metrics = { recordSimilarityAction: jest.fn() };
  const logger = { error: jest.fn(), log: jest.fn() };
  const baseline = jest.fn();
  Object.assign(engine, {
    similarity,
    metrics,
    logger,
    resolveCursorPlaylistSong: baseline,
  });
  const resolve = (
    mode: 'shadow' | 'on',
    state: Record<string, unknown> = {},
  ) =>
    engine.resolveWithSimilarity('radio-1', state, sequence(), 0, mode, 1000);
  return { engine, similarity, metrics, logger, baseline, resolve };
}

const result = (overrides: Record<string, unknown> = {}) => ({
  outcome: 'selected',
  chosen: { songId: 102, score: 0.9 },
  runnerUps: [{ songId: 103, score: 0.7 }],
  cycleReset: true,
  ...overrides,
});

describe('SongExecutionEngine similarity coverage', () => {
  it('asks for a proposal with favorites blocked and the last ended song', () => {
    const h = build();
    h.similarity.propose.mockReturnValue({ result: result(), leaf: null });
    h.baseline.mockReturnValue(null);
    h.resolve('shadow', { lastEnded: { songId: 101, artist: 'Artist one' } });
    const [programId, request] = h.similarity.propose.mock.calls[0] as Call;
    expect(programId).toBe('radio-1');
    expect(request.currentSongId).toBe(101);
    expect(request.currentArtist).toBe('Artist one');
    expect(
      request.leaves.map((entry) => [entry.leaf.id, entry.blocked]),
    ).toEqual([
      ['song-1', false],
      ['song-2', true],
    ]);
  });

  it('falls back to the cursor and logs when the proposal throws', () => {
    for (const mode of ['on', 'shadow'] as const) {
      const h = build();
      h.similarity.propose.mockImplementation(() => {
        throw new Error('boom');
      });
      h.baseline.mockReturnValue(leafOne);
      expect(h.resolve(mode)).toBe(leafOne);
      expect(h.logger.error).toHaveBeenCalledWith(
        'Similarity proposal failed on radio-1; using the playlist cursor: Error: boom',
      );
      expect(h.similarity.recordDecision).not.toHaveBeenCalled();
      expect(h.metrics.recordSimilarityAction).not.toHaveBeenCalled();
    }
  });

  it('shadow: records the proposal beside what the cursor played', () => {
    const h = build();
    h.similarity.propose.mockReturnValue({ result: result(), leaf: leafTwo });
    h.baseline.mockReturnValue(leafOne);
    expect(h.resolve('shadow', { lastEnded: { songId: 100 } })).toBe(leafOne);
    expect(h.similarity.recordDecision).toHaveBeenCalledWith('radio-1', {
      mode: 'shadow',
      outcome: 'selected',
      currentSongId: 100,
      proposedSongId: 102,
      playedSongId: 101,
      score: 0.9,
      runnerUps: [{ songId: 103, score: 0.7 }],
    });
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith(
      'shadow-recorded',
    );
  });

  it('shadow: records nulls when nothing was chosen or played', () => {
    const h = build();
    h.similarity.propose.mockReturnValue({
      result: result({
        outcome: 'fallback-no-candidate',
        chosen: null,
        runnerUps: [],
      }),
      leaf: null,
    });
    h.baseline.mockReturnValue(null);
    expect(h.resolve('shadow')).toBeNull();
    expect(h.similarity.recordDecision).toHaveBeenCalledWith('radio-1', {
      mode: 'shadow',
      outcome: 'fallback-no-candidate',
      currentSongId: null,
      proposedSongId: null,
      playedSongId: null,
      score: null,
      runnerUps: [],
    });
  });

  it('on: plays the proposed sequence song and arms the cycle reset', () => {
    const h = build();
    const state: Record<string, unknown> = { lastEnded: { songId: 100 } };
    h.similarity.propose.mockReturnValue({ result: result(), leaf: leafTwo });
    expect(h.resolve('on', state)).toBe(leafTwo);
    expect(state.pendingCycleReset).toBe(true);
    expect(h.baseline).not.toHaveBeenCalled();
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith('selected');
    expect(h.similarity.recordDecision).toHaveBeenCalledWith('radio-1', {
      mode: 'on',
      outcome: 'selected',
      currentSongId: 100,
      proposedSongId: 102,
      playedSongId: 102,
      score: 0.9,
      runnerUps: [{ songId: 103, score: 0.7 }],
    });
  });

  it('on: plays a catalog proposal without moving the sequence cursor', () => {
    const h = build();
    const catalogLeaf = {
      ...leafOne,
      id: `${CATALOG_ITEM_PREFIX}55`,
      songId: undefined,
    };
    h.similarity.propose.mockReturnValue({
      result: result({ chosen: null, runnerUps: [], cycleReset: false }),
      leaf: catalogLeaf,
    });
    const state: Record<string, unknown> = {};
    expect(h.resolve('on', state)).toBe(catalogLeaf);
    expect(state.pendingCycleReset).toBe(false);
    expect(h.similarity.recordDecision).toHaveBeenCalledWith('radio-1', {
      mode: 'on',
      outcome: 'selected',
      currentSongId: null,
      proposedSongId: null,
      playedSongId: null,
      score: null,
      runnerUps: [],
    });
  });

  it.each([
    ['fallback-no-embedding', 'fallback-no-embedding', leafOne, 101],
    ['fallback-no-candidate', 'fallback-no-candidate', null, null],
    ['anything-else', 'fallback-no-candidate', leafOne, 101],
  ])(
    'on: falls back to the cursor for outcome %s',
    (outcome, action, played, playedSongId) => {
      const h = build();
      h.similarity.propose.mockReturnValue({
        result: result({ outcome, chosen: null, runnerUps: [] }),
        leaf: null,
      });
      h.baseline.mockReturnValue(played);
      expect(h.resolve('on', { lastEnded: { songId: 100 } })).toBe(played);
      expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith(action);
      expect(h.similarity.recordDecision).toHaveBeenCalledWith('radio-1', {
        mode: 'on',
        outcome,
        currentSongId: 100,
        proposedSongId: null,
        playedSongId,
        score: null,
        runnerUps: [],
      });
    },
  );

  it('marks the started song as a cycle reset only for playlist picks', () => {
    const start = (pendingCycleReset: boolean) => {
      const h = build();
      const state = {
        sequence: sequence(),
        queue: [],
        queueBlocked: false,
        pendingRequestIds: new Set<string>(),
        pendingCycleReset,
      } as unknown as StartState;
      Object.assign(h.engine, {
        flightService: { isClockedLogRunning: () => false },
        states: new Map([['radio-1', state]]),
        resolveNextPlaylistSong: () => leafOne,
        pushCommand: jest.fn().mockResolvedValue(undefined),
        emitPlaybackActive: jest.fn(),
        publishNowPlaying: jest.fn().mockResolvedValue(undefined),
        startProgress: jest.fn(),
        isRadioCapable: () => true,
      });
      expect(h.engine.playNext('radio-1')).toBe(true);
      return state;
    };

    const reset = start(true);
    expect(reset.activeSong.cycleReset).toBe(true);
    expect(reset.pendingCycleReset).toBe(false);
    expect(start(false).activeSong.cycleReset).toBeUndefined();
  });
});
