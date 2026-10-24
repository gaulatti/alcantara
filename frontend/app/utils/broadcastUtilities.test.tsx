import { describe, expect, it } from 'vitest';
import { formatClockParts, getOverrideClockParts } from './broadcastTime';
import { normalizeProgramSongQueue } from './songQueue';
import { getMediaLibraryView } from './mediaLibrary';
import { getSceneTransitionPreset, SCENE_TRANSITIONS } from './sceneTransitions';
import {
  clampUnit, dbToFader, dbToGain, faderToDb, faderToGain, formatGainDb,
  gainToDb, gainToMeterFill, interpolateGainLog,
} from './audioTaper';

describe('broadcast clock', () => {
  const startedAt = '2026-10-24T12:00:00Z';
  it('advances an override across midnight and formats a two-digit clock', () => {
    const parts = getOverrideClockParts({ startTime: ' 23:59 ', startedAt }, new Date('2026-10-24T12:01:03Z'));
    expect(parts).toEqual({ hours: 0, minutes: 0, seconds: 3 });
    expect(formatClockParts(parts!)).toBe('00:00');
    expect(formatClockParts({ hours: 14, minutes: 25, seconds: 59 })).toBe('14:25');
  });
  it('holds the requested clock while the start instant is in the future', () => {
    expect(getOverrideClockParts({ startTime: '07:05', startedAt }, new Date('2026-10-24T11:59:59Z')))
      .toEqual({ hours: 7, minutes: 5, seconds: 0 });
  });
  it.each(['24:00', '12:60', '9:00', '', '12:00:01'])('refuses invalid override time %s', (startTime) => {
    expect(getOverrideClockParts({ startTime, startedAt })).toBeNull();
  });
  it('refuses an invalid start instant', () => {
    expect(getOverrideClockParts({ startTime: '12:00', startedAt: 'invalid' })).toBeNull();
  });
});

describe('operator song queue input', () => {
  it('normalizes valid references, rejects malformed entries, and preserves FIFO order', () => {
    expect(normalizeProgramSongQueue([
      null, false, 'song', [], {}, { id: 1, itemId: 'song', enqueuedAt: 100 },
      { id: 'q', itemId: 1, enqueuedAt: 100 }, { id: 'q', itemId: 's', enqueuedAt: '100' },
      { id: 'q', itemId: 's', enqueuedAt: Infinity }, { id: 'q', itemId: 's', enqueuedAt: 0 },
      { id: ' q1 ', itemId: ' track1 ', enqueuedAt: 100.7 },
      { id: 'q1', itemId: 'duplicate', enqueuedAt: 101 },
      { id: 'q2', itemId: 'track2', enqueuedAt: 102 },
    ])).toEqual([
      { id: 'q1', itemId: 'track1', enqueuedAt: 101 }, { id: 'q2', itemId: 'track2', enqueuedAt: 102 },
    ]);
    expect(normalizeProgramSongQueue({ items: [] })).toEqual([]);
  });
  it('bounds a loaded queue at its documented 100 references', () => {
    const queue = normalizeProgramSongQueue(Array.from({ length: 101 }, (_, index) => ({
      id: `q${index}`, itemId: `song${index}`, enqueuedAt: index + 1,
    })));
    expect(queue).toHaveLength(100);
    expect(queue[99]).toEqual({ id: 'q99', itemId: 'song99', enqueuedAt: 100 });
  });
});

describe('media section routing', () => {
  it.each([
    ['tv', '', 'images', 'IMAGE', null], ['tv', 'type=AUDIO', 'audio', 'AUDIO', null],
    ['both', 'type=VIDEO', 'video', 'VIDEO', null], ['tv', 'type=invalid', 'images', 'IMAGE', null],
    ['radio', '', 'audio', 'AUDIO', '/media?type=AUDIO'],
    ['radio', 'type=AUDIO', 'audio', 'AUDIO', null],
    ['radio', 'type=VIDEO&view=labels', 'labels', 'AUDIO', null],
    ['tv', 'view=labels', 'labels', 'IMAGE', null],
  ] as const)('routes %s with %s to its canonical section', (mode, search, activeSection, mediaType, canonicalHref) => {
    const view = getMediaLibraryView(mode, new URLSearchParams(search));
    expect(view).toMatchObject({ activeSection, mediaType, canonicalHref, isLabelsView: activeSection === 'labels' });
    expect(view.visibleSections).toEqual(mode === 'radio' ? ['audio', 'labels'] : ['images', 'audio', 'video', 'labels']);
  });
});

describe('scene transition selection', () => {
  it('retains known presets and uses Cut for absent or unknown selections', () => {
    for (const preset of SCENE_TRANSITIONS) {
      expect(getSceneTransitionPreset(` ${preset.id} `)).toBe(preset);
      expect(preset.cutPointMs).toBeLessThanOrEqual(preset.durationMs);
    }
    expect(getSceneTransitionPreset().id).toBe('cut');
    expect(getSceneTransitionPreset(null).id).toBe('cut');
    expect(getSceneTransitionPreset('not-a-transition').id).toBe('cut');
  });
});

describe('audio console gain mapping', () => {
  it('clamps faders and handles silence and non-finite values explicitly', () => {
    expect(clampUnit(NaN)).toBe(1);
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(2)).toBe(1);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(NaN)).toBe(-Infinity);
    expect(gainToDb(1)).toBe(0);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-6)).toBeCloseTo(0.501187);
    expect(faderToDb(0)).toBe(-Infinity);
    expect(faderToDb(1)).toBe(0);
    expect(dbToFader(-Infinity)).toBe(0);
    expect(dbToFader(-100)).toBe(0);
    expect(dbToFader(1)).toBe(1);
  });
  it('maps the console calibration points and interpolates their inverses', () => {
    for (const [fader, db] of [[0.015, -75], [0.03, -70], [0.12, -45], [0.28, -28], [0.5, -15], [0.72, -8], [0.88, -3], [0.99, -0.25]]) {
      expect(faderToDb(fader)).toBeCloseTo(db);
      expect(dbToFader(db)).toBeCloseTo(fader);
      expect(faderToGain(fader)).toBeCloseTo(dbToGain(db));
    }
    expect(faderToGain(0)).toBe(0);
    expect(formatGainDb(0)).toBe('-inf dB');
    expect(formatGainDb(1)).toBe('0.0 dB');
  });
  it('shows silence and unity consistently and interpolates logarithmic fades', () => {
    expect(gainToMeterFill(0)).toBe(0);
    expect(gainToMeterFill(1)).toBe(1);
    expect(gainToMeterFill(0.01)).toBe(0);
    expect(gainToMeterFill(0.5)).toBeGreaterThan(0);
    expect(interpolateGainLog(0.1, 1, 0)).toBe(0.1);
    expect(interpolateGainLog(0.1, 1, 1)).toBe(1);
    expect(interpolateGainLog(0.1, 1, 0.5)).toBeCloseTo(Math.sqrt(0.1));
    expect(interpolateGainLog(0, 1, 0.5)).toBeCloseTo(0.01);
    expect(interpolateGainLog(1, 0, 0.5)).toBeCloseTo(0.01);
  });
});
