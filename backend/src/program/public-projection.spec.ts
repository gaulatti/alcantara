import { MAX_SEQUENCE_DEPTH } from '../radio/song-sequence.utils';
import {
  projectPublicAudioBus,
  projectPublicProgramSignal,
  projectPublicProgramState,
  projectPublicScene,
  projectPublicSongSequence,
} from './public-projection';

describe('public projection', () => {
  it('answers null for anything that is not a record, and fills the state defaults', () => {
    for (const value of [null, undefined, 'x', 3, []]) {
      expect(projectPublicScene(value)).toBeNull();
      expect(projectPublicProgramState(value)).toBeNull();
      expect(projectPublicSongSequence(value)).toBeNull();
      expect(projectPublicAudioBus(value)).toBeNull();
    }
    expect(projectPublicProgramState({})).toEqual({
      activeSceneId: null,
      version: undefined,
      fadeToBlack: false,
      stingers: [],
      activeScene: null,
      stagedScene: null,
    });
  });

  it('keeps a scene with no layout, chyron or metadata, and a stinger with no stinger row', () => {
    expect(projectPublicScene({ id: 1 })).toEqual({
      id: 1,
      layout: { componentType: undefined },
      chyronText: null,
      metadata: null,
    });
    expect(
      projectPublicProgramState({
        stingers: [{ stingerId: 2 }, 'not-an-entry'],
      })?.stingers,
    ).toEqual([{ stingerId: 2, stinger: null }]);
  });

  it('cuts a sequence with no items, drops items that are not records, and stops at the deepest nesting', () => {
    expect(projectPublicSongSequence({ mode: 'manual' })).toEqual({
      mode: 'manual',
      items: [],
    });
    expect(
      projectPublicSongSequence({
        items: ['x', { id: 'a', kind: 'preset', songId: 1 }],
      }),
    ).toEqual({
      items: [{ id: 'a', kind: 'preset' }],
    });
    let nested: Record<string, unknown> = { items: [] };
    for (let depth = 0; depth <= MAX_SEQUENCE_DEPTH; depth++)
      nested = {
        items: [
          { id: `n${depth}`, kind: 'sequence', label: 'L', sequence: nested },
        ],
      };
    const flat = JSON.stringify(projectPublicSongSequence(nested));
    expect(flat).toContain('"n1"');
    expect(flat).not.toContain('"n0"');
  });

  it('keeps a null sequence null, and leaves an audio bus with no sequence without one', () => {
    expect(
      projectPublicAudioBus({ songSequence: null, songQueue: [1] }),
    ).toEqual({ songSequence: null });
    expect(projectPublicAudioBus({ mixerSettings: { a: 1 } })).toEqual({
      mixerSettings: { a: 1 },
    });
  });

  it('leaves other events and non-records alone, and cuts only the fields each event carries', () => {
    expect(projectPublicProgramSignal('x')).toBe('x');
    expect(
      projectPublicProgramSignal({ type: 'instant_play', instant: { id: 1 } }),
    ).toEqual({ type: 'instant_play', instant: { id: 1 } });
    expect(
      projectPublicProgramSignal({ type: 'scene_staged', stagedSceneId: null }),
    ).toEqual({ type: 'scene_staged', stagedSceneId: null });
    expect(
      projectPublicProgramSignal({
        type: 'program_reload',
        settings: { keep: true },
      }),
    ).toEqual({ type: 'program_reload', settings: { keep: true } });
    expect(
      projectPublicProgramSignal({
        type: 'audio_bus_snapshot',
        settings: { songQueue: [1] },
      }),
    ).toEqual({ type: 'audio_bus_snapshot', settings: {} });
    expect(
      projectPublicProgramSignal({ type: 'song_queue_update', songQueue: [1] }),
    ).toEqual({ type: 'song_queue_update' });
    expect(
      projectPublicProgramSignal({
        type: 'song_queue_update',
        songSequence: null,
      }),
    ).toEqual({ type: 'song_queue_update', songSequence: null });
  });
});
