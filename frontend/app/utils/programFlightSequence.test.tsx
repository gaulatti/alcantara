import { describe, expect, it } from 'vitest';
import { createFlightCue, getFlightCueDisplayLabel, normalizeFlightCue, normalizeFlightSequence } from './programFlightSequence';
import type { FlightCue, FlightCueKind } from '../models/broadcast';

describe('rundown cue normalization', () => {
  it('rejects non-records and unknown cue kinds', () => {
    for (const value of [null, undefined, [], 'cue', {}, { kind: 1 }, { kind: 'unknown' }]) {
      expect(normalizeFlightCue(value)).toBeNull();
    }
  });
  it('retains operator cue fields while discarding malformed optional values', () => {
    const cue = normalizeFlightCue({
      id: ' cue-1 ', kind: 'mixer', label: ' Opening ', isFiller: true,
      clockOffsetSeconds: 20.6, voiceTrackInstantId: 7.2, voiceDuckGain: 0.25,
      voiceFadeInSeconds: 0.5, voiceFadeOutSeconds: 1.5, sceneId: 3.2,
      transitionId: ' cut ', songId: 4.4, durationMs: 1000.2, metadataPatch: { chyronText: 'Hello' },
      instantId: 8.2, mixerChange: { channelId: 'song', volume: 1, muted: false, solo: true },
    });
    expect(cue).toEqual({
      id: 'cue-1', kind: 'mixer', label: 'Opening', isFiller: true,
      clockOffsetSeconds: 21, voiceTrackInstantId: 7, voiceDuckGain: 0.25,
      voiceFadeInSeconds: 0.5, voiceFadeOutSeconds: 1.5, sceneId: 3,
      transitionId: 'cut', songId: 4, durationMs: 1000, metadataPatch: { chyronText: 'Hello' },
      instantId: 8, mixerChange: { channelId: 'song', volume: 1, muted: false, solo: true },
    });
    expect(normalizeFlightCue({
      kind: 'wait', id: ' ', label: ' ', clockOffsetSeconds: Infinity,
      durationMs: -1, metadataPatch: [], voiceDuckGain: NaN,
      mixerChange: { channelId: 'unknown', volume: Infinity, muted: 'true', solo: 'true' },
    })).toMatchObject({ kind: 'wait', label: undefined, mixerChange: {} });
    expect(normalizeFlightCue({ kind: 'wait' })?.id).toMatch(/^cue_/);
  });
  it('retains every supported cue kind and documented new-cue defaults', () => {
    const kinds: FlightCueKind[] = ['scene', 'playSong', 'stopSong', 'wait', 'waitForSongEnd', 'sceneUpdate', 'instant', 'mixer'];
    for (const kind of kinds) expect(normalizeFlightCue({ kind })?.kind).toBe(kind);
    expect(createFlightCue()).toMatchObject({ kind: 'wait', durationMs: 3000 });
    expect(createFlightCue('scene')).toMatchObject({ kind: 'scene', transitionId: 'cut' });
    expect(createFlightCue('stopSong')).toMatchObject({ kind: 'stopSong' });
  });
  it('normalizes sequence metadata without treating malformed stored fields as running state', () => {
    for (const value of [null, [], 1]) expect(normalizeFlightSequence(value)).toBeNull();
    expect(normalizeFlightSequence({
      id: 3, name: 'Daily rundown', items: [{ id: 'a', kind: 'wait', durationMs: 500 }, null],
      loop: true, isRunning: true, activeItemId: 'a', scheduledAt: 'schedule',
      publishedAt: 'published', lastStartedAt: 'started', revision: 8,
      createdAt: 'created', updatedAt: 'updated',
    })).toEqual({
      id: 3, name: 'Daily rundown', items: [{ id: 'a', kind: 'wait', label: undefined, durationMs: 500 }],
      loop: true, isRunning: true, activeItemId: 'a', scheduledAt: 'schedule',
      publishedAt: 'published', lastStartedAt: 'started', revision: 8,
      createdAt: 'created', updatedAt: 'updated',
    });
    const malformed = normalizeFlightSequence({ id: Infinity, name: 1, items: 'bad', loop: 'true', isRunning: 1, activeItemId: 1, revision: 1.5 });
    expect(malformed).toMatchObject({ id: 0, name: 'Unnamed', items: [], loop: false, isRunning: false, activeItemId: null, scheduledAt: null, publishedAt: null, lastStartedAt: null, revision: 1 });
    expect(Date.parse(malformed!.createdAt)).toBeGreaterThan(0);
    expect(normalizeFlightSequence({ activeItemId: null })?.activeItemId).toBeNull();
  });
});

describe('rundown cue labels', () => {
  const context = {
    scenes: [{ id: 3, name: 'Opening' }], songs: [{ id: 4, artist: 'Artist', title: 'Song' }],
    instants: [{ id: 8, name: 'Bumper' }],
  };
  const label = (cue: Omit<FlightCue, 'id'>) => getFlightCueDisplayLabel({ id: 'cue', ...cue }, context);
  it('prefers an editorial label over generated cue details', () => {
    expect(label({ kind: 'scene', sceneId: 3, label: 'Custom opening' })).toBe('Custom opening');
  });
  it('uses catalog names when available and retains raw references otherwise', () => {
    expect(label({ kind: 'scene', sceneId: 3 })).toBe('Scene: Opening');
    expect(label({ kind: 'playSong', songId: 4 })).toBe('Play: Artist - Song');
    expect(label({ kind: 'instant', instantId: 8 })).toBe('Instant: Bumper');
    expect(label({ kind: 'scene', sceneId: 30 })).toBe('Scene 30');
    expect(label({ kind: 'playSong', songId: 40 })).toBe('Play song 40');
    expect(label({ kind: 'instant', instantId: 80 })).toBe('Instant 80');
    expect(getFlightCueDisplayLabel({ id: 'a', kind: 'scene', sceneId: 3 })).toBe('Scene 3');
    expect(getFlightCueDisplayLabel({ id: 'a', kind: 'playSong', songId: 4 })).toBe('Play song 4');
    expect(getFlightCueDisplayLabel({ id: 'a', kind: 'instant', instantId: 8 })).toBe('Instant 8');
  });
  it('describes simple cue kinds and missing optional references', () => {
    expect(label({ kind: 'scene' })).toBe('Scene');
    expect(label({ kind: 'playSong' })).toBe('Play song');
    expect(label({ kind: 'stopSong' })).toBe('Stop song');
    expect(label({ kind: 'wait', durationMs: 500 })).toBe('Wait 500ms');
    expect(label({ kind: 'wait' })).toBe('Wait');
    expect(label({ kind: 'waitForSongEnd' })).toBe('Wait for song end');
    expect(label({ kind: 'sceneUpdate', sceneId: 3 })).toBe('Update scene 3');
    expect(label({ kind: 'sceneUpdate' })).toBe('Update scene');
    expect(label({ kind: 'instant' })).toBe('Instant');
    expect(label({ kind: 'mixer' })).toBe('Mixer');
    expect(getFlightCueDisplayLabel({ id: 'a', kind: 'unknown' as FlightCueKind })).toBe('Cue');
  });
  it('shows selected channel, level and both enabled and disabled mixer flags', () => {
    expect(label({ kind: 'mixer', mixerChange: { channelId: 'song', volume: 0.5, muted: true, solo: true } }))
      .toBe('Mixer: song vol 50% mute solo');
    expect(label({ kind: 'mixer', mixerChange: { channelId: 'stream', muted: false, solo: false } }))
      .toBe('Mixer: stream unmute unsolo');
    expect(label({ kind: 'mixer', mixerChange: { channelId: 'main' } })).toBe('Mixer: main');
  });
});
