import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlightCue } from '../models/broadcast';
import {
  createFlightCue,
  getFlightCueDisplayLabel,
  normalizeFlightCue,
  normalizeFlightSequence
} from './programFlightSequence';

describe('flight cue normalization', () => {
  it('rejects non-objects and unknown kinds', () => {
    expect(normalizeFlightCue(null)).toBeNull();
    expect(normalizeFlightCue([])).toBeNull();
    expect(normalizeFlightCue({ kind: 7 })).toBeNull();
    expect(normalizeFlightCue({ kind: 'explode' })).toBeNull();
  });

  it('keeps every recognised field, trimmed and rounded', () => {
    const cue = normalizeFlightCue({
      id: ' cue-1 ',
      kind: 'scene',
      label: '  Opening  ',
      isFiller: true,
      clockOffsetSeconds: 12.4,
      voiceTrackInstantId: 9.6,
      voiceDuckGain: 0.35,
      voiceFadeInSeconds: 1.5,
      voiceFadeOutSeconds: 2,
      sceneId: 4,
      transitionId: ' fade ',
      songId: 11,
      durationMs: 2500.2,
      metadataPatch: { headline: 'x' },
      instantId: 3,
      mixerChange: { channelId: 'song', volume: 1, muted: true, solo: false }
    });
    expect(cue).toEqual({
      id: 'cue-1',
      kind: 'scene',
      label: 'Opening',
      isFiller: true,
      clockOffsetSeconds: 12,
      voiceTrackInstantId: 10,
      voiceDuckGain: 0.35,
      voiceFadeInSeconds: 1.5,
      voiceFadeOutSeconds: 2,
      sceneId: 4,
      transitionId: 'fade',
      songId: 11,
      durationMs: 2500,
      metadataPatch: { headline: 'x' },
      instantId: 3,
      mixerChange: { channelId: 'song', volume: 1, muted: true, solo: false }
    });
  });

  it('drops invalid optional fields and generates an id when none is given', () => {
    const cue = normalizeFlightCue({
      id: '   ',
      kind: 'mixer',
      label: '   ',
      isFiller: 'yes',
      clockOffsetSeconds: Number.NaN,
      voiceDuckGain: Number.POSITIVE_INFINITY,
      sceneId: '4',
      transitionId: 5,
      durationMs: -1,
      metadataPatch: ['x'],
      mixerChange: { channelId: 'nowhere', volume: 'loud', muted: 'no', solo: 1 }
    });
    expect(cue?.id).toMatch(/^cue_/);
    expect(cue).toEqual({ id: cue?.id, kind: 'mixer', label: undefined, mixerChange: {} });
  });
});

describe('flight sequence normalization', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects non-objects', () => {
    expect(normalizeFlightSequence('sequence')).toBeNull();
  });

  it('keeps valid fields and drops invalid cues', () => {
    const sequence = normalizeFlightSequence({
      id: 7,
      name: 'Morning',
      items: [{ id: 'a', kind: 'wait', durationMs: 10 }, { kind: 'bogus' }],
      loop: true,
      isRunning: true,
      activeItemId: 'a',
      scheduledAt: '2026-11-21T08:00:00Z',
      publishedAt: '2026-11-21T07:00:00Z',
      lastStartedAt: '2026-11-21T08:00:01Z',
      revision: 3,
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z'
    });
    expect(sequence).toEqual({
      id: 7,
      name: 'Morning',
      items: [{ id: 'a', kind: 'wait', label: undefined, durationMs: 10 }],
      loop: true,
      isRunning: true,
      activeItemId: 'a',
      scheduledAt: '2026-11-21T08:00:00Z',
      publishedAt: '2026-11-21T07:00:00Z',
      lastStartedAt: '2026-11-21T08:00:01Z',
      revision: 3,
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z'
    });
  });

  it('fills defaults for missing or malformed fields', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    expect(
      normalizeFlightSequence({ id: Number.NaN, name: 3, items: 'none', activeItemId: 4, revision: 1.5 })
    ).toEqual({
      id: 0,
      name: 'Unnamed',
      items: [],
      loop: false,
      isRunning: false,
      activeItemId: null,
      scheduledAt: null,
      publishedAt: null,
      lastStartedAt: null,
      revision: 1,
      createdAt: '2026-11-21T12:00:00.000Z',
      updatedAt: '2026-11-21T12:00:00.000Z'
    });
    expect(normalizeFlightSequence({ activeItemId: null })?.activeItemId).toBeNull();
  });
});

describe('new flight cues', () => {
  it('gives a wait three seconds, a scene a cut, and other kinds nothing extra', () => {
    expect(createFlightCue()).toMatchObject({ kind: 'wait', durationMs: 3000 });
    expect(createFlightCue('scene')).toMatchObject({ kind: 'scene', transitionId: 'cut' });
    const stop = createFlightCue('stopSong');
    expect(Object.keys(stop).sort()).toEqual(['id', 'kind']);
  });
});

describe('flight cue labels', () => {
  const context = {
    scenes: [{ id: 1, name: 'Studio' }],
    songs: [{ id: 2, title: 'Volare', artist: 'Modugno' }],
    instants: [{ id: 3, name: 'Applause' }]
  };
  const label = (cue: Partial<FlightCue>, withContext = true) =>
    getFlightCueDisplayLabel({ id: 'c', kind: 'wait', ...cue } as FlightCue, withContext ? context : undefined);

  it('prefers an explicit label', () => {
    expect(label({ kind: 'scene', label: 'Custom' })).toBe('Custom');
  });

  it('names scenes, songs and instants from the context, else by id, else generically', () => {
    expect(label({ kind: 'scene', sceneId: 1 })).toBe('Scene: Studio');
    expect(label({ kind: 'scene', sceneId: 9 })).toBe('Scene 9');
    expect(label({ kind: 'scene', sceneId: 1 }, false)).toBe('Scene 1');
    expect(label({ kind: 'scene' })).toBe('Scene');
    expect(label({ kind: 'playSong', songId: 2 })).toBe('Play: Modugno - Volare');
    expect(label({ kind: 'playSong', songId: 9 })).toBe('Play song 9');
    expect(label({ kind: 'playSong' })).toBe('Play song');
    expect(label({ kind: 'instant', instantId: 3 })).toBe('Instant: Applause');
    expect(label({ kind: 'instant', instantId: 9 }, false)).toBe('Instant 9');
    expect(label({ kind: 'instant' })).toBe('Instant');
  });

  it('describes the remaining kinds', () => {
    expect(label({ kind: 'stopSong' })).toBe('Stop song');
    expect(label({ kind: 'wait', durationMs: 500 })).toBe('Wait 500ms');
    expect(label({ kind: 'wait' })).toBe('Wait');
    expect(label({ kind: 'waitForSongEnd' })).toBe('Wait for song end');
    expect(label({ kind: 'sceneUpdate', sceneId: 4 })).toBe('Update scene 4');
    expect(label({ kind: 'sceneUpdate' })).toBe('Update scene');
    expect(label({ kind: 'unknown' as FlightCue['kind'] })).toBe('Cue');
  });

  it('summarises a mixer change', () => {
    expect(label({ kind: 'mixer', mixerChange: { channelId: 'main', volume: 0.5, muted: true, solo: true } })).toBe(
      'Mixer: main vol 50% mute solo'
    );
    expect(label({ kind: 'mixer', mixerChange: { channelId: 'song', muted: false, solo: false } })).toBe(
      'Mixer: song unmute unsolo'
    );
    expect(label({ kind: 'mixer', mixerChange: {} })).toBe('Mixer');
    expect(label({ kind: 'mixer' })).toBe('Mixer');
  });
});
