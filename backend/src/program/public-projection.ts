/**
 * What the public program routes and the public event stream send for a program with no template manifest
 * (gaulatti/alcantara#25): the fields the on-air pages read, and nothing else. The signed-in control routes send the
 * whole state; a templated program keeps its own versioned projection (program-template.service).
 */

import {
  MAX_SEQUENCE_DEPTH,
  PLAYABLE_SONG_LEAF_FIELDS,
} from '../radio/song-sequence.utils';

type Value = Record<string, unknown>;

function isRecord(value: unknown): value is Value {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(source: Value, fields: readonly string[]): Value {
  const picked: Value = {};
  for (const field of fields) if (source[field] !== undefined) picked[field] = source[field];
  return picked;
}

/** A scene as the on-air pages read it: its id, its component, its chyron and its whole metadata. */
export function projectPublicScene(value: unknown): Value | null {
  if (!isRecord(value)) return null;
  return {
    id: value.id,
    layout: { componentType: isRecord(value.layout) ? value.layout.componentType : undefined },
    chyronText: value.chyronText ?? null,
    metadata: value.metadata ?? null,
  };
}

/** A program stinger entry, in the `{ stingerId, stinger }` shape the program page reads. */
function projectPublicStinger(value: unknown): Value | null {
  if (!isRecord(value)) return null;
  return {
    stingerId: value.stingerId,
    stinger: isRecord(value.stinger) ? pick(value.stinger, ['name', 'videoUrl', 'cutPointMs']) : null,
  };
}

/** The program state the on-air pages read. Everything else (the scene list, media groups, queue, settings) stays. */
export function projectPublicProgramState(value: unknown): Value | null {
  if (!isRecord(value)) return null;
  return {
    activeSceneId: value.activeSceneId ?? null,
    version: value.version,
    fadeToBlack: value.fadeToBlack === true,
    stingers: Array.isArray(value.stingers)
      ? value.stingers.map(projectPublicStinger).filter((entry) => entry !== null)
      : [],
    activeScene: projectPublicScene(value.activeScene),
    stagedScene: projectPublicScene(value.stagedScene),
  };
}

const SEQUENCE_FIELDS = [
  'mode',
  'activeItemId',
  'intervalMs',
  'loop',
  'startedAt',
  'shuffleOrder',
  'endedAt',
  'cuedItemId',
] as const;

function projectSequenceItem(value: unknown, depth: number): Value | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'sequence') {
    const sequence = projectPublicSongSequence(value.sequence, depth + 1);
    return sequence ? { id: value.id, kind: 'sequence', label: value.label, sequence } : null;
  }
  return pick(value, PLAYABLE_SONG_LEAF_FIELDS);
}

/**
 * A song sequence with its structure (mode, order, cursor, timing, nesting) and each leaf cut to what the page plays
 * and shows: its audio, title, artist, length, cover and chart rank.
 */
export function projectPublicSongSequence(value: unknown, depth = 0): Value | null {
  if (!isRecord(value) || depth > MAX_SEQUENCE_DEPTH) return null;
  return {
    ...pick(value, SEQUENCE_FIELDS),
    items: Array.isArray(value.items)
      ? value.items.map((item) => projectSequenceItem(item, depth)).filter((item) => item !== null)
      : [],
  };
}

/** The audio bus as the page reads it: the mixer and the cut sequence. The song queue stays. */
export function projectPublicAudioBus(value: unknown): Value | null {
  if (!isRecord(value)) return null;
  return {
    ...pick(value, ['sequenceVersion', 'shuffleKeepsRows', 'mixerSettings']),
    ...(value.songSequence !== undefined
      ? { songSequence: value.songSequence === null ? null : projectPublicSongSequence(value.songSequence) }
      : {}),
  };
}

/** A live event on the public stream of a program with no template manifest, with its state and audio bus cut. */
export function projectPublicProgramSignal(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const event: Value = { ...value };
  if (event.state !== undefined) event.state = projectPublicProgramState(event.state);
  if (event.type === 'scene_staged' && event.scene !== undefined) event.scene = projectPublicScene(event.scene);
  if (event.settings !== undefined && (event.type === 'audio_bus_update' || event.type === 'audio_bus_snapshot'))
    event.settings = projectPublicAudioBus(event.settings);
  if (event.type === 'song_queue_update') {
    delete event.songQueue;
    if (event.songSequence !== undefined)
      event.songSequence = event.songSequence === null ? null : projectPublicSongSequence(event.songSequence);
  }
  return event;
}
