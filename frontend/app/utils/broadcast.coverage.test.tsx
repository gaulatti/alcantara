import { describe, expect, it } from 'vitest';
import {
  formatTakePresetDbInputValue,
  getMixerChannelById,
  isEditableTarget,
  normalizeMixerChannelsPayload,
  normalizeProgramAudioMeter,
  normalizeProgramSongPlayback,
  normalizeSceneInstantPlayback,
  normalizeSlideshowImageList,
  normalizeTakeVolumeFadeMs,
  normalizeTakeVolumePresetDb,
  normalizeUpdateVersion,
  parseMixerLevelInputToFader,
  parseSceneMetadata,
  readControlUpdateVersion,
  reconcileProgramSongPlayback,
  resolveControlUpdateTopicFromType,
  withIndependentProgramClockMetadata
} from './broadcast';

describe('editable targets', () => {
  it('treats form fields and editable content as editable, and anything else as not', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(editable)).toBe(true);
  });
});

describe('take volume presets', () => {
  it('accepts numeric strings and falls back on anything unreadable', () => {
    expect(normalizeTakeVolumePresetDb('-12', -15)).toBe(-12);
    expect(normalizeTakeVolumePresetDb('loud', -15)).toBe(-15);
    expect(normalizeTakeVolumeFadeMs('250.6', 500)).toBe(251);
    expect(normalizeTakeVolumeFadeMs(undefined, 500)).toBe(500);
    expect(normalizeTakeVolumeFadeMs(99999, 500)).toBe(20000);
    expect(formatTakePresetDbInputValue(-6)).toBe('-6.0');
    expect(formatTakePresetDbInputValue(Number.NaN)).toBe('-15.0');
  });
});

describe('mixer channels', () => {
  const fallback = [{ id: 'song', name: 'Song', volume: 0.8, muted: true, solo: false }];

  it('keeps the fallback values for fields a payload leaves out, and skips unreadable items', () => {
    expect(
      normalizeMixerChannelsPayload(
        [null, [], 'song', { id: 3 }, { id: '  ' }, { id: 'song', name: '  ' }, { id: ' extra ' }],
        fallback
      )
    ).toEqual([
      { id: 'song', name: 'Song', volume: 0.8, muted: true, solo: false },
      { id: 'extra', name: 'extra', volume: 1, muted: false, solo: false }
    ]);
  });

  it('returns a neutral channel for an unknown id', () => {
    expect(getMixerChannelById(fallback, 'stream')).toEqual({
      id: 'stream',
      name: 'stream',
      volume: 1,
      muted: false,
      solo: false
    });
  });

  it('reads typed levels, treating blank input as unchanged', () => {
    expect(parseMixerLevelInputToFader('   ', 0.4)).toBe(0.4);
    expect(parseMixerLevelInputToFader('-inf', 0.4)).toBe(0);
    expect(parseMixerLevelInputToFader('quiet', 0.4)).toBe(0.4);
    expect(parseMixerLevelInputToFader('0 dB', 0.4)).toBeGreaterThan(0);
  });
});

describe('playback payloads', () => {
  it('returns silent meters and idle playback for a missing payload', () => {
    const meter = normalizeProgramAudioMeter(null);
    expect(meter.updatedAt).toBe(new Date(0).toISOString());
    expect(normalizeProgramAudioMeter({}).updatedAt).not.toBe(new Date(0).toISOString());
    expect(normalizeProgramAudioMeter({ updatedAt: 'then' }).updatedAt).toBe('then');
    expect(normalizeProgramSongPlayback(undefined)).toMatchObject({ token: '', isPlaying: false, durationMs: null });
    expect(normalizeSceneInstantPlayback(0)).toMatchObject({ sceneId: null, instantName: '' });
  });

  it('reads song playback fields and drops malformed ones', () => {
    const full = normalizeProgramSongPlayback({
      token: 't',
      audioUrl: 'https://media.example.test/a.mp3',
      currentTimeMs: 5000,
      durationMs: 4000,
      updatedAt: 'now',
      telemetryStale: true,
      introStatus: 'playing',
      introFailureReason: '  slow  ',
      queueEntryId: ' q1 '
    });
    expect(full).toMatchObject({
      currentTimeMs: 4000,
      durationMs: 4000,
      updatedAt: 'now',
      telemetryStale: true,
      introStatus: 'playing',
      introFailureReason: 'slow',
      queueEntryId: 'q1'
    });
    const sparse = normalizeProgramSongPlayback({ token: 1, audioUrl: 2, introStatus: 'weird', introFailureReason: '   ', queueEntryId: '  ' });
    expect(sparse).toMatchObject({ token: '', audioUrl: '', introStatus: 'none', introFailureReason: null, queueEntryId: null });
    expect(sparse.telemetryStale).toBeUndefined();
    for (const status of ['pending', 'completed', 'degraded'] as const) {
      expect(normalizeProgramSongPlayback({ introStatus: status }).introStatus).toBe(status);
    }
  });

  it('reads a scene instant from the nested instant or the top level', () => {
    expect(
      normalizeSceneInstantPlayback({ sceneId: 2, instant: { id: 5, assetId: ' a-1 ', name: 'Bell' }, updatedAt: 'now' })
    ).toMatchObject({ sceneId: 2, instantId: 5, mediaAssetId: 'a-1', instantName: 'Bell', updatedAt: 'now' });
    expect(normalizeSceneInstantPlayback({ instant: [], mediaAssetId: '  ' })).toMatchObject({
      instantId: null,
      mediaAssetId: null,
      instantName: ''
    });
  });

  it('keeps the previous position when the same playing song jumps backwards too far', () => {
    const prev = normalizeProgramSongPlayback({ token: 't', audioUrl: 'u', isPlaying: true, currentTimeMs: 60000 });
    const back = normalizeProgramSongPlayback({ token: 't', audioUrl: 'u', isPlaying: true, currentTimeMs: 0 });
    const close = normalizeProgramSongPlayback({ token: 't', audioUrl: 'u', isPlaying: true, currentTimeMs: 59999 });
    expect(reconcileProgramSongPlayback(prev, back)).toBe(prev);
    expect(reconcileProgramSongPlayback(prev, close)).toBe(close);
    expect(reconcileProgramSongPlayback({ ...prev, isPlaying: false }, back)).toBe(back);
    expect(reconcileProgramSongPlayback(prev, { ...back, audioUrl: 'other' })).toEqual({ ...back, audioUrl: 'other' });
    expect(reconcileProgramSongPlayback(prev, { ...back, token: 'other' })).toEqual({ ...back, token: 'other' });
  });
});

describe('control update topics and versions', () => {
  it('maps every update type to its topic', () => {
    expect(resolveControlUpdateTopicFromType(4)).toBeNull();
    expect(resolveControlUpdateTopicFromType('flight_update')).toBe('flight');
    expect(resolveControlUpdateTopicFromType('song_off_air')).toBe('songPlayback');
    expect(resolveControlUpdateTopicFromType('nothing')).toBeNull();
  });

  it('reads the version from the top level, then the topic-specific place', () => {
    expect(normalizeUpdateVersion(-1)).toBeNull();
    expect(normalizeUpdateVersion('2.7')).toBe(2);
    expect(readControlUpdateVersion('state', null)).toBeNull();
    expect(readControlUpdateVersion('state', [])).toBeNull();
    expect(readControlUpdateVersion('state', { version: 4 })).toBe(4);
    expect(readControlUpdateVersion('state', { stateVersion: 3 })).toBe(3);
    expect(readControlUpdateVersion('audioBus', { settings: { version: 2 } })).toBe(2);
    expect(readControlUpdateVersion('audioMeter', { audioMeterVersion: 6 })).toBe(6);
    expect(readControlUpdateVersion('songPlayback', { playback: { version: 7 } })).toBe(7);
    expect(readControlUpdateVersion('sceneInstant', { sceneInstantVersion: 8 })).toBe(8);
    expect(readControlUpdateVersion('flight', { flightVersion: 9 })).toBe(9);
    expect(readControlUpdateVersion('other' as never, { flightVersion: 9 })).toBeNull();
  });
});

describe('slideshow and scene metadata', () => {
  it('splits a comma or newline list given as a string, and ignores other values', () => {
    expect(normalizeSlideshowImageList('a.jpg, b.jpg\na.jpg')).toEqual(['a.jpg', 'b.jpg']);
    expect(normalizeSlideshowImageList(['a.jpg', 3])).toEqual(['a.jpg']);
    expect(normalizeSlideshowImageList(7)).toEqual([]);
  });

  it('reads an object, and returns an empty one for anything else', () => {
    expect(parseSceneMetadata('{"a":1}')).toEqual({ a: 1 });
    expect(parseSceneMetadata(null)).toEqual({});
    expect(parseSceneMetadata('[1]')).toEqual({});
    expect(parseSceneMetadata('null')).toEqual({});
    expect(parseSceneMetadata('{bad')).toEqual({});
  });

  it('passes program clock metadata through unchanged', () => {
    const metadata = { clock: { mode: 'local' } };
    expect(withIndependentProgramClockMetadata(metadata)).toBe(metadata);
  });
});
