import {
  parsePalazzoState,
  parsePalazzoEvent,
  parsePalazzoMixerState,
} from './palazzo-contract';

const level = { rms: 0.1, peak: 0.3 };
const levels = { song: level, instant: level, output: level };
const liquidsoap = {
  running: true,
  connected: true,
  staleSince: null,
  lastSampleAt: null,
};
const track = {
  playbackRequestId: 'song',
  url: 'https://media.invalid/song',
  startedAt: '2026-10-24T12:00:00Z',
  title: 'Title',
  artist: 'Artist',
  coverUrl: 'https://media.invalid/cover',
};
const intro = {
  playbackId: 'intro',
  parentPlaybackId: 'song',
  programId: 'radio',
  playbackRequestId: 'song',
  url: 'https://media.invalid/intro',
  startedAt: '2026-10-24T12:00:00Z',
  status: 'playing',
};
const state = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  instanceId: 'palazzo',
  bootId: 'boot',
  sequence: 0,
  availability: 'available',
  status: 'idle',
  track: null,
  intro: null,
  liquidsoap,
  icecast: { connected: true },
  positionSeconds: 0,
  remainingSeconds: null,
  levels,
  ...overrides,
});
const event = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'boot:1',
  instanceId: 'palazzo',
  bootId: 'boot',
  sequence: 1,
  type: 'heartbeat',
  occurredAt: '2026-10-24T12:00:00Z',
  data: {},
  ...overrides,
});

describe('Palazzo immutable wire-schema boundaries', () => {
  it.each([null, false, 4, 'state', []].map((value) => [value]))(
    'rejects non-state payload %j',
    (value) => {
      expect(parsePalazzoState(value)).toBeNull();
    },
  );

  it.each([
    { schemaVersion: 2 },
    { instanceId: 4 },
    { bootId: null },
    { sequence: -1 },
    { sequence: 0.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { availability: 'guessing' },
    { status: 'unknown' },
    { track: {} },
    { intro: {} },
    { levels: null },
    { levels: { ...levels, intro: {} } },
    { levels: { ...levels, song: null } },
    { levels: { ...levels, instant: {} } },
    { levels: { ...levels, output: { rms: 0, peak: Infinity } } },
    { liquidsoap: null },
    { liquidsoap: { ...liquidsoap, running: 1 } },
    { liquidsoap: { ...liquidsoap, connected: 'true' } },
    { liquidsoap: { ...liquidsoap, staleSince: false } },
    { liquidsoap: { ...liquidsoap, lastSampleAt: false } },
    { icecast: null },
    { icecast: { connected: 1 } },
    { positionSeconds: -1 },
    { positionSeconds: NaN },
    { remainingSeconds: -1 },
    { remainingSeconds: Infinity },
  ])('rejects incomplete or inconsistent state field %j', (override) => {
    expect(parsePalazzoState(state(override))).toBeNull();
  });

  it('retains a valid degraded playing snapshot, optional intro levels and explicit timing', () => {
    const value = state({
      availability: 'degraded',
      status: 'playing',
      sequence: 8,
      track,
      intro: { ...intro, status: 'failed', failureReason: 'asset unavailable' },
      levels: { ...levels, intro: level },
      liquidsoap: {
        ...liquidsoap,
        staleSince: '2026-10-24T11:59:58Z',
        lastSampleAt: '2026-10-24T12:00:00Z',
      },
      remainingSeconds: 60,
    });
    expect(parsePalazzoState(value)).toEqual(value);
    const withoutIntro = state();
    delete (withoutIntro as Partial<typeof withoutIntro>).intro;
    expect(parsePalazzoState(withoutIntro)).toMatchObject({ intro: null });
  });

  it.each([
    { playbackRequestId: '' },
    { playbackRequestId: 'x'.repeat(201) },
    { url: '' },
    { url: 4 },
    { startedAt: 4 },
    { startedAt: 'not a timestamp' },
  ])('rejects a malformed track atomically: %j', (override) => {
    expect(
      parsePalazzoState(state({ track: { ...track, ...override } })),
    ).toBeNull();
  });

  it('normalizes absent and nonstring editorial metadata to null without losing playback identity', () => {
    expect(
      parsePalazzoState(
        state({
          track: { ...track, title: '', artist: 4, coverUrl: undefined },
        }),
      )?.track,
    ).toEqual({ ...track, title: null, artist: null, coverUrl: null });
    expect(parsePalazzoState(state({ track }))?.track).toEqual(track);
  });

  it.each([
    { playbackId: '' },
    { parentPlaybackId: '' },
    { programId: 'x'.repeat(129) },
    { playbackRequestId: false },
    { url: false },
    { startedAt: false },
    { startedAt: 'not a date' },
    { status: 'pending' },
    { failureReason: 4 },
  ])('rejects malformed intro ownership or lifecycle data: %j', (override) => {
    expect(
      parsePalazzoState(state({ intro: { ...intro, ...override } })),
    ).toBeNull();
  });

  it.each([null, 'mixer', false, []].map((value) => [value]))(
    'rejects a non-mixer payload %j',
    (value) => {
      expect(parsePalazzoMixerState(value)).toBeNull();
    },
  );

  const mixer = {
    mainVolume: 1,
    songVolume: 0.5,
    instantVolume: 0.5,
    songMuted: false,
    instantMuted: true,
  };
  it.each([
    { mainVolume: NaN },
    { songVolume: '0.5' },
    { instantVolume: Infinity },
    { songMuted: 'false' },
    { instantMuted: 0 },
  ])('rejects invalid numeric or mute mixer field %j', (override) => {
    expect(parsePalazzoMixerState({ ...mixer, ...override })).toBeNull();
  });

  it('retains finite canonical mixer values', () => {
    expect(parsePalazzoMixerState(mixer)).toEqual(mixer);
  });

  it.each([null, false, 4, 'event', []].map((value) => [value]))(
    'rejects non-event payload %j',
    (value) => {
      expect(parsePalazzoEvent(value)).toBeNull();
    },
  );

  it.each([
    { schemaVersion: 2 },
    { id: '' },
    { id: 'x'.repeat(301) },
    { instanceId: 'x'.repeat(201) },
    { bootId: '' },
    { sequence: -1 },
    { sequence: 0.5 },
    { type: 'unrecognized' },
    { occurredAt: 4 },
    { occurredAt: 'not a timestamp' },
    { data: null },
    { data: 'data' },
    { data: [] },
  ])('rejects uncorrelatable event data %j', (override) => {
    expect(parsePalazzoEvent(event(override))).toBeNull();
  });

  it.each(['track.started', 'track.ended'])(
    'requires a bounded request identity for %s',
    (type) => {
      expect(parsePalazzoEvent(event({ type, data: {} }))).toBeNull();
      expect(
        parsePalazzoEvent(event({ type, data: { playbackRequestId: 'song' } })),
      ).toEqual(event({ type, data: { playbackRequestId: 'song' } }));
    },
  );

  it.each(['intro.started', 'intro.ended', 'intro.failed'])(
    'requires every ownership binding for %s',
    (type) => {
      const data = {
        programId: 'radio',
        playbackId: 'intro',
        parentPlaybackId: 'song',
      };
      for (const key of Object.keys(data))
        expect(
          parsePalazzoEvent(event({ type, data: { ...data, [key]: '' } })),
        ).toBeNull();
      expect(parsePalazzoEvent(event({ type, data }))).toEqual(
        event({ type, data }),
      );
    },
  );
});
