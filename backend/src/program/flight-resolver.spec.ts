import { resolve } from './flight-resolver';
import type { FlightCue } from './flight.types';
// The desired-state module holds only types; load it so coverage measures it, as
// flight.service.coverage-clock.spec.ts does for flight.types.ts.
import './flight-resolver.types';

const START = 1_800_000_000_000;
const NO_DURATIONS = new Map<number, number>();

const sequence = (items: FlightCue[], loop = false) => ({ items, loop });
const at = (ms: number) => START + ms;

const empty = {
  scene: null,
  sceneMetadataPatch: {},
  song: null,
  mixer: {},
  activeCueId: null,
  finished: false,
};

describe('flight resolver', () => {
  it('returns the empty state before the start and on a clock that is not finite', () => {
    const seq = sequence([{ id: 'take', kind: 'scene', sceneId: 1 }]);
    expect(resolve(seq, START, at(-1), NO_DURATIONS)).toEqual(empty);
    expect(resolve(seq, START, Number.NaN, NO_DURATIONS)).toEqual(empty);
    expect(resolve(seq, START, Number.POSITIVE_INFINITY, NO_DURATIONS)).toEqual(empty);
  });

  it('takes a scene with its transition and clears earlier patches', () => {
    const seq = sequence([
      { id: 'a', kind: 'scene', sceneId: 1 },
      { id: 'patch', kind: 'sceneUpdate', sceneId: 1, metadataPatch: { headline: 'Old' } },
      { id: 'b', kind: 'scene', sceneId: 2, transitionId: 'wipe' },
      { id: 'hold', kind: 'wait', durationMs: 1000 },
    ]);
    expect(resolve(seq, START, at(0), NO_DURATIONS)).toEqual({
      ...empty,
      scene: { sceneId: 2, transitionId: 'wipe' },
      activeCueId: 'hold',
    });
  });

  it('ignores a scene cue without a scene', () => {
    const seq = sequence([
      { id: 'a', kind: 'scene', sceneId: 1 },
      { id: 'broken', kind: 'scene' },
      { id: 'hold', kind: 'wait', durationMs: 10 },
    ]);
    expect(resolve(seq, START, at(5), NO_DURATIONS).scene).toEqual({ sceneId: 1, transitionId: null });
  });

  it('merges scene updates for the scene on Program, in order, and ignores the rest', () => {
    const seq = sequence([
      { id: 'early', kind: 'sceneUpdate', sceneId: 1, metadataPatch: { before: true } },
      { id: 'take', kind: 'scene', sceneId: 1 },
      { id: 'p1', kind: 'sceneUpdate', sceneId: 1, metadataPatch: { headline: 'First', ticker: 'On' } },
      { id: 'p2', kind: 'sceneUpdate', metadataPatch: { headline: 'Second' } },
      { id: 'other', kind: 'sceneUpdate', sceneId: 9, metadataPatch: { headline: 'Elsewhere' } },
      { id: 'bad', kind: 'sceneUpdate', sceneId: 1 },
      { id: 'list', kind: 'sceneUpdate', sceneId: 1, metadataPatch: ['x'] as unknown as Record<string, unknown> },
      { id: 'hold', kind: 'wait', durationMs: 10 },
    ]);
    expect(resolve(seq, START, at(1), NO_DURATIONS).sceneMetadataPatch).toEqual({ headline: 'Second', ticker: 'On' });
  });

  it('sets each named mixer channel; main takes only a volume; unnamed changes are ignored', () => {
    const seq = sequence([
      { id: 'm1', kind: 'mixer', mixerChange: { channelId: 'song', volume: 0.4 } },
      { id: 'm2', kind: 'mixer', mixerChange: { channelId: 'song', muted: true } },
      { id: 'm3', kind: 'mixer', mixerChange: { channelId: 'stream', solo: true, volume: 1 } },
      { id: 'm4', kind: 'mixer', mixerChange: { channelId: 'main', volume: 0.8, muted: true } },
      { id: 'm5', kind: 'mixer', mixerChange: { channelId: 'main', muted: true } },
      { id: 'm6', kind: 'mixer', mixerChange: { volume: 0.1 } },
      { id: 'm7', kind: 'mixer' },
      { id: 'hold', kind: 'wait', durationMs: 10 },
    ]);
    expect(resolve(seq, START, at(1), NO_DURATIONS).mixer).toEqual({
      song: { volume: 0.4, muted: true },
      stream: { volume: 1, solo: true },
      main: { volume: 0.8 },
    });
  });

  it('starts a song at position 0, plays it on, and stops it', () => {
    const seq = sequence([
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'hold', kind: 'wait', durationMs: 5000 },
      { id: 'stop', kind: 'stopSong' },
      { id: 'after', kind: 'wait', durationMs: 5000 },
    ]);
    expect(resolve(seq, START, at(0), NO_DURATIONS).song).toEqual({ songId: 7, positionMs: 0 });
    expect(resolve(seq, START, at(2500), NO_DURATIONS).song).toEqual({ songId: 7, positionMs: 2500 });
    expect(resolve(seq, START, at(6000), NO_DURATIONS)).toMatchObject({ song: null, activeCueId: 'after' });
  });

  it('plays a song without a song id with no known duration', () => {
    const seq = sequence([
      { id: 'play', kind: 'playSong' },
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'hold', kind: 'wait', durationMs: 100 },
    ]);
    expect(resolve(seq, START, at(50), NO_DURATIONS)).toMatchObject({ song: { songId: null, positionMs: 50 }, activeCueId: 'hold' });
  });

  it('ends a song with a known duration once it has played', () => {
    const seq = sequence([
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'hold', kind: 'wait', durationMs: 10_000 },
    ]);
    const durations = new Map([[7, 3000]]);
    expect(resolve(seq, START, at(2999), durations).song).toEqual({ songId: 7, positionMs: 2999 });
    expect(resolve(seq, START, at(3000), durations).song).toBeNull();
  });

  it('changes nothing for an instant cue', () => {
    const seq = sequence([
      { id: 'take', kind: 'scene', sceneId: 1 },
      { id: 'hold', kind: 'wait', durationMs: 10 },
      { id: 'bell', kind: 'instant', instantId: 3 },
      { id: 'after', kind: 'wait', durationMs: 10 },
    ]);
    const before = resolve(seq, START, at(5), NO_DURATIONS);
    const after = resolve(seq, START, at(15), NO_DURATIONS);
    expect({ ...after, activeCueId: before.activeCueId }).toEqual(before);
  });

  it('holds a wait until its last millisecond and moves on at its end', () => {
    const seq = sequence([
      { id: 'hold', kind: 'wait', durationMs: 1000 },
      { id: 'take', kind: 'scene', sceneId: 4 },
      { id: 'next', kind: 'wait', durationMs: 1000 },
    ]);
    expect(resolve(seq, START, at(999), NO_DURATIONS)).toMatchObject({ activeCueId: 'hold', scene: null });
    expect(resolve(seq, START, at(1000), NO_DURATIONS)).toMatchObject({ activeCueId: 'next', scene: { sceneId: 4 } });
    expect(resolve(seq, START, at(1001), NO_DURATIONS)).toMatchObject({ activeCueId: 'next', scene: { sceneId: 4 } });
  });

  it('treats a wait without a positive duration as taking no time', () => {
    const seq = sequence([
      { id: 'none', kind: 'wait' },
      { id: 'negative', kind: 'wait', durationMs: -5 },
      { id: 'hold', kind: 'wait', durationMs: 10 },
    ]);
    expect(resolve(seq, START, at(0), NO_DURATIONS).activeCueId).toBe('hold');
  });

  it('waits for the rest of a song with a known duration', () => {
    const seq = sequence([
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'intro', kind: 'wait', durationMs: 1000 },
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'take', kind: 'scene', sceneId: 2 },
    ]);
    const durations = new Map([[7, 4000]]);
    expect(resolve(seq, START, at(3999), durations)).toMatchObject({ activeCueId: 'end', song: { songId: 7, positionMs: 3999 } });
    expect(resolve(seq, START, at(4000), durations)).toMatchObject({ finished: true, song: null, scene: { sceneId: 2 } });
  });

  it('does not wait for a song with an unknown or unusable duration, or when none plays', () => {
    const seq = (songId: number) => sequence([
      { id: 'play', kind: 'playSong', songId },
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'take', kind: 'scene', sceneId: 2 },
      { id: 'hold', kind: 'wait', durationMs: 100 },
    ]);
    const durations = new Map([[8, Number.NaN], [9, -1]]);
    for (const songId of [7, 8, 9]) {
      expect(resolve(seq(songId), START, at(0), durations)).toMatchObject({ activeCueId: 'hold', scene: { sceneId: 2 } });
    }
    const silent = sequence([
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'take', kind: 'scene', sceneId: 3 },
      { id: 'hold', kind: 'wait', durationMs: 100 },
    ]);
    expect(resolve(silent, START, at(0), NO_DURATIONS).scene).toEqual({ sceneId: 3, transitionId: null });
  });

  it('is final and finished after the last cue of a non-looping sequence', () => {
    const seq = sequence([
      { id: 'take', kind: 'scene', sceneId: 1 },
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'hold', kind: 'wait', durationMs: 1000 },
    ]);
    expect(resolve(seq, START, at(5000), NO_DURATIONS)).toEqual({
      ...empty,
      scene: { sceneId: 1, transitionId: null },
      song: { songId: 7, positionMs: 5000 },
      finished: true,
    });
    expect(resolve(sequence([]), START, at(0), NO_DURATIONS)).toEqual({ ...empty, finished: true });
  });

  it('wraps elapsed time when the sequence loops', () => {
    const seq = sequence([
      { id: 'a', kind: 'scene', sceneId: 1 },
      { id: 'holdA', kind: 'wait', durationMs: 1000 },
      { id: 'b', kind: 'scene', sceneId: 2 },
      { id: 'holdB', kind: 'wait', durationMs: 500 },
    ], true);
    expect(resolve(seq, START, at(1499), NO_DURATIONS)).toMatchObject({ activeCueId: 'holdB', scene: { sceneId: 2 } });
    expect(resolve(seq, START, at(1500), NO_DURATIONS)).toMatchObject({ activeCueId: 'holdA', scene: { sceneId: 1 }, finished: false });
    // A day in, 86,400,000 ms = 57,600 whole cycles: back at the start of a cycle.
    expect(resolve(seq, START, at(86_400_000), NO_DURATIONS)).toMatchObject({ activeCueId: 'holdA', scene: { sceneId: 1 } });
    expect(resolve(seq, START, at(86_400_000 + 1200), NO_DURATIONS)).toMatchObject({ activeCueId: 'holdB' });
  });

  it('carries a song across the loop and keeps its position', () => {
    const seq = sequence([
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'hold', kind: 'wait', durationMs: 1000 },
    ], true);
    const durations = new Map([[7, 3000]]);
    // Cycle 1: 0-1000 hold. Cycle 2: 1000-3000 waits for the song's last 2000 ms,
    // then restarts it; from then on every cycle lasts the song's 3000 ms.
    expect(resolve(seq, START, at(2500), durations)).toMatchObject({ activeCueId: 'end', song: { songId: 7, positionMs: 2500 } });
    expect(resolve(seq, START, at(3500), durations)).toMatchObject({ activeCueId: 'hold', song: { songId: 7, positionMs: 500 } });
    expect(resolve(seq, START, at(3000 + 3000 * 1000 + 200), durations)).toMatchObject({ activeCueId: 'hold', song: { songId: 7, positionMs: 200 } });
    expect(resolve(seq, START, at(3000 + 3000 * 1000 + 2200), durations)).toMatchObject({ activeCueId: 'end', song: { songId: 7, positionMs: 2200 } });
  });

  it('keeps a song with an unknown duration playing across a looping sequence', () => {
    const seq = sequence([
      { id: 'play', kind: 'playSong', songId: 5 },
      { id: 'hold', kind: 'wait', durationMs: 1000 },
      { id: 'stop', kind: 'stopSong' },
      { id: 'gap', kind: 'wait', durationMs: 1000 },
    ], true);
    expect(resolve(seq, START, at(2000 * 50 + 300), NO_DURATIONS)).toMatchObject({ activeCueId: 'hold', song: { songId: 5, positionMs: 300 } });
    expect(resolve(seq, START, at(2000 * 50 + 1300), NO_DURATIONS)).toMatchObject({ activeCueId: 'gap', song: null });
  });

  it('restarts a song with an unknown duration on every pass of a loop', () => {
    const seq = sequence([
      { id: 'hold', kind: 'wait', durationMs: 1000 },
      { id: 'play', kind: 'playSong', songId: 5 },
    ], true);
    expect(resolve(seq, START, at(2500), NO_DURATIONS)).toMatchObject({ activeCueId: 'hold', song: { songId: 5, positionMs: 500 } });
    expect(resolve(seq, START, at(1000 * 500 + 250), NO_DURATIONS)).toMatchObject({ activeCueId: 'hold', song: { songId: 5, positionMs: 250 } });
  });

  it('returns after one pass when a looping sequence consumes no time', () => {
    const seq = sequence([
      { id: 'take', kind: 'scene', sceneId: 1 },
      { id: 'bell', kind: 'instant', instantId: 2 },
      { id: 'end', kind: 'waitForSongEnd' },
    ], true);
    expect(resolve(seq, START, at(60_000), NO_DURATIONS)).toEqual({
      ...empty,
      scene: { sceneId: 1, transitionId: null },
      activeCueId: 'end',
      finished: false,
    });
    expect(resolve(sequence([], true), START, at(10), NO_DURATIONS)).toEqual(empty);
  });

  it('is deterministic and never mutates its inputs', () => {
    const items: FlightCue[] = [
      { id: 'take', kind: 'scene', sceneId: 1, transitionId: 'cut' },
      { id: 'patch', kind: 'sceneUpdate', sceneId: 1, metadataPatch: { headline: 'A', nested: { deep: [1, 2] } } },
      { id: 'mix', kind: 'mixer', mixerChange: { channelId: 'song', volume: 0.5 } },
      { id: 'play', kind: 'playSong', songId: 7 },
      { id: 'end', kind: 'waitForSongEnd' },
      { id: 'hold', kind: 'wait', durationMs: 750 },
    ];
    const durations = new Map([[7, 2000], [8, 100]]);
    const seqs = [sequence(items, false), sequence(items, true)];
    for (const seq of seqs) {
      const original = structuredClone({ seq, durations: [...durations] });
      for (let i = 0; i < 200; i += 1) {
        const startedAtMs = START + ((i * 7919) % 5000) - 2500;
        const nowMs = START + ((i * 104_729) % 20_000);
        const first = resolve(seq, startedAtMs, nowMs, durations);
        const second = resolve(seq, startedAtMs, nowMs, durations);
        expect(second).toEqual(first);
      }
      expect({ seq, durations: [...durations] }).toEqual(original);
    }
  });
});
