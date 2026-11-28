import type { FlightCue, FlightSequence } from './flight.types';
import type {
  FlightDesiredState,
  FlightMixerChannelState,
} from './flight-resolver.types';

/**
 * Pure rundown resolver (gaulatti/alcantara#152).
 *
 * Given a sequence, the time it started and the current time, it computes what
 * should be on air, without I/O, without reading a clock and without mutating
 * its inputs. Nothing calls it yet; the executor in `flight.service.ts` still
 * runs rundowns with timers.
 *
 * Cues take effect in order:
 * - `scene` puts its scene on Program and clears the accumulated patches.
 * - `sceneUpdate` merges its `metadataPatch` into the patches of the scene on
 *   Program (a patch naming another scene is ignored).
 * - `mixer` sets the named channel; `main` takes only a volume, as the executor
 *   does, and a change without a channel is ignored.
 * - `playSong` starts its song at position 0; `stopSong` stops it. A song with
 *   a known duration is over once that duration has played.
 * - `instant` changes nothing here.
 * - `wait` consumes `durationMs`; `waitForSongEnd` consumes what remains of the
 *   current song, or nothing when no song plays or its duration is unknown.
 *   Every other cue consumes no time.
 *
 * A looping sequence starts over after its last cue and its elapsed time wraps;
 * a sequence whose passes consume no time returns after one pass. A
 * non-looping sequence is final, and `finished`, after its last cue.
 */
/** A song started at `startMs` on the sequence's own timeline. */
interface PlayingSong {
  songId: number | null;
  startMs: number;
}

export function resolve(
  sequence: Pick<FlightSequence, 'items' | 'loop'>,
  startedAtMs: number,
  nowMs: number,
  songDurationsMs: ReadonlyMap<number, number>,
): FlightDesiredState {
  const state = emptyState();
  const elapsed = nowMs - startedAtMs;
  // Before the start (or on a clock that is not a finite time) nothing is on air.
  if (!Number.isFinite(elapsed) || elapsed < 0) return state;

  const cues = sequence.items;
  // Held in an object so the cue callbacks and the loop share one current song.
  const playback: { song: PlayingSong | null } = { song: null };
  let t = 0;

  /** A song's duration when it is known as a finite, non-negative number. */
  const durationOf = (songId: number | null) => {
    const duration = songId === null ? undefined : songDurationsMs.get(songId);
    return duration !== undefined && Number.isFinite(duration) && duration >= 0
      ? duration
      : undefined;
  };
  /** The playing song at time `at`, or null once a known duration has played. */
  const songAt = (at: number): PlayingSong | null => {
    const song = playback.song;
    if (!song) return null;
    const duration = durationOf(song.songId);
    return duration !== undefined && at - song.startMs >= duration
      ? null
      : song;
  };
  const finish = (at: number): FlightDesiredState => {
    const playing = songAt(at);
    state.song = playing && {
      songId: playing.songId,
      positionMs: at - playing.startMs,
    };
    return state;
  };

  // Only the song in progress changes how long a pass takes, so a pass that
  // starts with the same song state as an earlier one repeats it exactly.
  const passStarts = new Map<string, number>();
  for (;;) {
    if (sequence.loop) {
      const playing = songAt(t);
      const duration = playing ? durationOf(playing.songId) : undefined;
      const key = !playing
        ? 'none'
        : duration === undefined
          ? `unknown:${playing.songId}`
          : `remaining:${playing.startMs + duration - t}`;
      const previous = passStarts.get(key);
      if (previous !== undefined) {
        const period = t - previous;
        if (period === 0) return finish(elapsed);
        const skipped = Math.floor((elapsed - t) / period) * period;
        t += skipped;
        if (playback.song) playback.song.startMs += skipped;
      }
      passStarts.set(key, t);
    }

    for (const cue of cues) {
      apply(state, cue, t, (next) => {
        playback.song = next;
      });
      const consumed = consumes(cue, songAt(t), t, durationOf);
      if (elapsed < t + consumed) return finish(elapsed);
      t += consumed;
    }

    if (!sequence.loop) {
      state.finished = true;
      state.activeCueId = null;
      return finish(elapsed);
    }
  }
}

function emptyState(): FlightDesiredState {
  return {
    scene: null,
    sceneMetadataPatch: {},
    song: null,
    mixer: {},
    activeCueId: null,
    finished: false,
  };
}

function apply(
  state: FlightDesiredState,
  cue: FlightCue,
  at: number,
  setSong: (song: PlayingSong | null) => void,
): void {
  state.activeCueId = cue.id;
  switch (cue.kind) {
    case 'scene':
      if (typeof cue.sceneId === 'number') {
        state.scene = {
          sceneId: cue.sceneId,
          transitionId: cue.transitionId ?? null,
        };
        state.sceneMetadataPatch = {};
      }
      break;
    case 'sceneUpdate':
      if (
        state.scene &&
        isRecord(cue.metadataPatch) &&
        (cue.sceneId === undefined || cue.sceneId === state.scene.sceneId)
      ) {
        state.sceneMetadataPatch = {
          ...state.sceneMetadataPatch,
          ...cue.metadataPatch,
        };
      }
      break;
    case 'mixer': {
      const change = cue.mixerChange;
      const channel = change?.channelId;
      if (!channel) break;
      const level =
        channel === 'main'
          ? pick(change, ['volume'])
          : pick(change, ['volume', 'muted', 'solo']);
      if (Object.keys(level).length === 0) break;
      state.mixer = {
        ...state.mixer,
        [channel]: { ...state.mixer[channel], ...level },
      };
      break;
    }
    case 'playSong':
      setSong({
        songId: typeof cue.songId === 'number' ? cue.songId : null,
        startMs: at,
      });
      break;
    case 'stopSong':
      setSong(null);
      break;
    default:
      break;
  }
}

function consumes(
  cue: FlightCue,
  playing: PlayingSong | null,
  at: number,
  durationOf: (songId: number | null) => number | undefined,
): number {
  if (cue.kind === 'wait') {
    return typeof cue.durationMs === 'number' && cue.durationMs > 0
      ? cue.durationMs
      : 0;
  }
  if (cue.kind === 'waitForSongEnd' && playing) {
    const duration = durationOf(playing.songId);
    return duration === undefined ? 0 : playing.startMs + duration - at;
  }
  return 0;
}

/** The listed fields of a mixer change that are set. */
function pick(
  change: NonNullable<FlightCue['mixerChange']>,
  fields: Array<keyof FlightMixerChannelState>,
): FlightMixerChannelState {
  const level: FlightMixerChannelState = {};
  for (const field of fields) {
    if (change[field] !== undefined)
      Object.assign(level, { [field]: change[field] });
  }
  return level;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
