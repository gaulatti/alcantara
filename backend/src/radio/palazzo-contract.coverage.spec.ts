import {
  classifyPalazzoFrame,
  parsePalazzoEvent,
  parsePalazzoMixerState,
  parsePalazzoState,
} from './palazzo-contract';

type Obj = Record<string, unknown>;
type StateShape = {
  liquidsoap: Obj;
  icecast: Obj;
  levels: Record<string, Obj>;
};

const level = () => ({ rms: 0.1, peak: 0.2 });

const validTrack = () => ({
  playbackRequestId: 'req-1',
  title: 'Title',
  artist: 'Artist',
  coverUrl: 'https://c.test/c.jpg',
  url: 'https://a.test/a.mp3',
  startedAt: '2026-01-01T00:00:00.000Z',
});

const validIntro = () => ({
  playbackId: 'intro-1',
  parentPlaybackId: 'req-1',
  programId: 'main',
  playbackRequestId: 'req-1',
  url: 'https://a.test/i.mp3',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'playing',
});

const validState = (): Record<string, any> & StateShape => ({
  schemaVersion: 1,
  instanceId: 'inst',
  bootId: 'boot',
  sequence: 3,
  availability: 'available',
  status: 'playing',
  liquidsoap: {
    running: true,
    connected: true,
    staleSince: null,
    lastSampleAt: '2026-01-01T00:00:00.000Z',
  },
  icecast: { connected: true },
  track: validTrack(),
  intro: null,
  positionSeconds: 12,
  remainingSeconds: 30,
  levels: { song: level(), instant: level(), output: level() },
});

const mutate = (change: (state: ReturnType<typeof validState>) => void) => {
  const state = validState();
  change(state);
  return state;
};

describe('parsePalazzoState coverage', () => {
  it('parses a full valid state', () => {
    expect(parsePalazzoState(validState())).toEqual({
      ...validState(),
      intro: null,
    });
  });

  it('keeps the live input report and rejects a malformed one (palazzo#48)', () => {
    expect(
      parsePalazzoState(
        mutate((s) => {
          s.live = { onAir: true };
        }),
      )?.live,
    ).toEqual({ onAir: true });
    expect(parsePalazzoState(validState())).not.toHaveProperty('live');
    for (const live of [null, 'on', { onAir: 'yes' }, {}])
      expect(
        parsePalazzoState(
          mutate((s) => {
            s.live = live;
          }),
        ),
      ).toBeNull();
  });

  it('keeps the optional intro level and a parsed intro', () => {
    const state = mutate((s) => {
      s.intro = validIntro();
      s.levels.intro = { rms: 0.3, peak: 0.4 };
      s.track = null;
      s.remainingSeconds = null;
      s.liquidsoap.staleSince = '2026-01-01T00:00:00.000Z';
      s.liquidsoap.lastSampleAt = null;
      s.availability = 'degraded';
      s.status = 'idle';
    });
    const parsed = parsePalazzoState(state)!;
    expect(parsed.intro).toEqual(validIntro());
    expect(parsed.levels.intro).toEqual({ rms: 0.3, peak: 0.4 });
    expect(parsed.track).toBeNull();
    expect(parsed.remainingSeconds).toBeNull();
    expect(parsed.availability).toBe('degraded');
  });

  it('accepts an absent intro and normalizes it to null', () => {
    const state = mutate((s) => {
      delete s.intro;
    });
    expect(parsePalazzoState(state)).not.toBeNull();
    expect(parsePalazzoState(state)!.intro).toBeNull();
  });

  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['a primitive', 'text'],
    ['a wrong schema version', mutate((s) => (s.schemaVersion = 2))],
    ['a non-string instance id', mutate((s) => (s.instanceId = 1))],
    ['a non-string boot id', mutate((s) => (s.bootId = 1))],
    ['a fractional sequence', mutate((s) => (s.sequence = 1.5))],
    ['a negative sequence', mutate((s) => (s.sequence = -1))],
    ['an invalid track', mutate((s) => (s.track = { bad: true }))],
    ['an undefined track', mutate((s) => delete s.track)],
    ['an invalid intro', mutate((s) => (s.intro = { bad: true }))],
    ['missing levels', mutate((s) => delete (s as Obj).levels)],
    ['missing liquidsoap', mutate((s) => delete (s as Obj).liquidsoap)],
    ['non-boolean running', mutate((s) => (s.liquidsoap.running = 1))],
    ['non-boolean connected', mutate((s) => (s.liquidsoap.connected = 1))],
    ['a numeric staleSince', mutate((s) => (s.liquidsoap.staleSince = 5))],
    ['a numeric lastSampleAt', mutate((s) => (s.liquidsoap.lastSampleAt = 5))],
    ['missing icecast', mutate((s) => delete (s as Obj).icecast)],
    ['non-boolean icecast', mutate((s) => (s.icecast.connected = 'y'))],
    ['negative position', mutate((s) => (s.positionSeconds = -1))],
    ['non-numeric position', mutate((s) => (s.positionSeconds = 'x'))],
    ['negative remaining', mutate((s) => (s.remainingSeconds = -1))],
    ['undefined remaining', mutate((s) => delete s.remainingSeconds)],
  ];
  it.each(invalid)('rejects %s', (_name, value) => {
    expect(parsePalazzoState(value)).toBeNull();
  });
});

describe('Palazzo capabilities (gaulatti/palazzo#50)', () => {
  it('keeps the listed capabilities, reads a malformed list as none, and omits an absent one', () => {
    expect(
      parsePalazzoState(mutate((s) => (s.capabilities = ['next.bumper'])))
        ?.capabilities,
    ).toEqual(['next.bumper']);
    expect(parsePalazzoState(validState())).not.toHaveProperty('capabilities');
    for (const capabilities of [
      'next.bumper',
      [1],
      ['x'.repeat(65)],
      [''],
      Array.from({ length: 33 }, (_, i) => `c${i}`),
    ])
      expect(
        parsePalazzoState(mutate((s) => (s.capabilities = capabilities)))
          ?.capabilities,
      ).toEqual([]);
  });
});

describe('parsePalazzoTrack (via state) coverage', () => {
  const withTrack = (change: (track: Record<string, any>) => void) =>
    mutate((s) => change(s.track));

  it.each([
    ['a non-object track', mutate((s) => (s.track = 'x'))],
    ['an empty playback id', withTrack((t) => (t.playbackRequestId = ''))],
    [
      'an overlong playback id',
      withTrack((t) => (t.playbackRequestId = 'x'.repeat(201))),
    ],
    ['a missing url', withTrack((t) => delete t.url)],
    ['an empty url', withTrack((t) => (t.url = ''))],
    ['a non-string startedAt', withTrack((t) => (t.startedAt = 5))],
    ['an unparsable startedAt', withTrack((t) => (t.startedAt = 'nope'))],
  ])('rejects %s', (_name, value) => {
    expect(parsePalazzoState(value)).toBeNull();
  });

  it('nulls non-string or empty metadata but keeps the rest', () => {
    const parsed = parsePalazzoState(
      withTrack((t) => {
        t.title = '';
        t.artist = 5;
        t.coverUrl = undefined;
      }),
    )!;
    expect(parsed.track).toEqual({
      ...validTrack(),
      title: null,
      artist: null,
      coverUrl: null,
    });
  });

  it('accepts a 200 character playback id', () => {
    const id = 'x'.repeat(200);
    expect(
      parsePalazzoState(withTrack((t) => (t.playbackRequestId = id)))!.track!
        .playbackRequestId,
    ).toBe(id);
  });
});

describe('parsePalazzoIntro (via state) coverage', () => {
  const withIntro = (change: (intro: Record<string, any>) => void) =>
    mutate((s) => {
      s.intro = validIntro();
      change(s.intro);
    });

  it('accepts a failed intro with a failure reason', () => {
    const parsed = parsePalazzoState(
      withIntro((i) => {
        i.status = 'failed';
        i.failureReason = 'decode';
      }),
    )!;
    expect(parsed.intro).toMatchObject({
      status: 'failed',
      failureReason: 'decode',
    });
  });

  it.each([
    ['a non-object intro', mutate((s) => (s.intro = 'x'))],
    ['a bad playback id', withIntro((i) => (i.playbackId = ''))],
    ['a bad parent id', withIntro((i) => (i.parentPlaybackId = ''))],
    ['a bad program id', withIntro((i) => (i.programId = 'x'.repeat(129)))],
    ['a bad request id', withIntro((i) => (i.playbackRequestId = ''))],
    ['a non-string url', withIntro((i) => (i.url = 5))],
    ['a non-string startedAt', withIntro((i) => (i.startedAt = 5))],
    ['an unparsable startedAt', withIntro((i) => (i.startedAt = 'nope'))],
    ['a non-string failure reason', withIntro((i) => (i.failureReason = 5))],
  ])('rejects %s', (_name, value) => {
    expect(parsePalazzoState(value)).toBeNull();
  });
});

describe('parsePalazzoLevels (via state) coverage', () => {
  it.each([
    ['non-object levels', mutate((s) => ((s as Obj).levels = 'x'))],
    ['missing song', mutate((s) => delete s.levels.song)],
    ['missing instant', mutate((s) => delete s.levels.instant)],
    ['missing output', mutate((s) => delete s.levels.output)],
    ['a non-object level', mutate((s) => ((s.levels as Obj).song = 'x'))],
    ['a non-finite rms', mutate((s) => (s.levels.song.rms = Infinity))],
    ['a non-numeric peak', mutate((s) => (s.levels.song.peak = '1'))],
    ['an invalid intro level', mutate((s) => (s.levels.intro = { rms: 'x' }))],
  ])('rejects %s', (_name, value) => {
    expect(parsePalazzoState(value)).toBeNull();
  });
});

describe('parsePalazzoMixerState coverage', () => {
  const valid = {
    mainVolume: 1,
    songVolume: 0.5,
    instantVolume: 0.2,
    songMuted: false,
    instantMuted: true,
  };

  it('returns a valid mixer state', () => {
    expect(parsePalazzoMixerState(valid)).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['a primitive', 5],
    ['a bad mainVolume', { ...valid, mainVolume: NaN }],
    ['a bad songVolume', { ...valid, songVolume: 'x' }],
    ['a bad instantVolume', { ...valid, instantVolume: undefined }],
    ['non-boolean songMuted', { ...valid, songMuted: 0 }],
    ['non-boolean instantMuted', { ...valid, instantMuted: 'no' }],
  ])('rejects %s', (_name, value) => {
    expect(parsePalazzoMixerState(value)).toBeNull();
  });
});

describe('parsePalazzoEvent coverage', () => {
  const validEvent = (): Record<string, any> => ({
    schemaVersion: 1,
    id: 'evt-1',
    instanceId: 'inst',
    bootId: 'boot',
    sequence: 5,
    type: 'heartbeat',
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: {},
  });
  const event = (change: (e: Record<string, any>) => void) => {
    const e = validEvent();
    change(e);
    return e;
  };

  it('accepts a plain event', () => {
    expect(parsePalazzoEvent(validEvent())).toEqual(validEvent());
  });

  it('accepts instant.started and instant.ended with a playback ID and refuses one without (gaulatti/palazzo#50)', () => {
    for (const type of ['instant.started', 'instant.ended']) {
      const e = event((x) => {
        x.type = type;
        x.data = {
          playbackId: 'spot-1',
          programId: 'main',
          liquidsoapSequence: 3,
        };
      });
      expect(parsePalazzoEvent(e)).toEqual(e);
      expect(
        parsePalazzoEvent(
          event((x) => {
            x.type = type;
            x.data = { programId: 'main' };
          }),
        ),
      ).toBeNull();
    }
  });

  it('accepts well-formed track and intro events', () => {
    for (const type of ['track.started', 'track.ended']) {
      const e = event((x) => {
        x.type = type;
        x.data = { playbackRequestId: 'req' };
      });
      expect(parsePalazzoEvent(e)).toEqual(e);
    }
    for (const type of ['intro.started', 'intro.ended', 'intro.failed']) {
      const e = event((x) => {
        x.type = type;
        x.data = { programId: 'main', playbackId: 'i', parentPlaybackId: 'p' };
      });
      expect(parsePalazzoEvent(e)).toEqual(e);
    }
  });

  it.each([
    ['null', null],
    ['a primitive', 'x'],
    ['a wrong schema', event((e) => (e.schemaVersion = 2))],
    ['an empty id', event((e) => (e.id = ''))],
    ['an overlong id', event((e) => (e.id = 'x'.repeat(301)))],
    ['an empty instance id', event((e) => (e.instanceId = ''))],
    ['an empty boot id', event((e) => (e.bootId = ''))],
    ['a fractional sequence', event((e) => (e.sequence = 0.5))],
    ['a negative sequence', event((e) => (e.sequence = -1))],
    ['an unknown type', event((e) => (e.type = 'nope'))],
    ['a non-string occurredAt', event((e) => (e.occurredAt = 5))],
    ['an unparsable occurredAt', event((e) => (e.occurredAt = 'nope'))],
    ['missing data', event((e) => delete e.data)],
    ['non-object data', event((e) => (e.data = 'x'))],
    ['array data', event((e) => (e.data = []))],
    [
      'a track event without a playback id',
      event((e) => {
        e.type = 'track.started';
        e.data = {};
      }),
    ],
    [
      'a track.ended event without a playback id',
      event((e) => {
        e.type = 'track.ended';
      }),
    ],
    [
      'an intro event without a program id',
      event((e) => {
        e.type = 'intro.started';
        e.data = { playbackId: 'i', parentPlaybackId: 'p' };
      }),
    ],
    [
      'an intro event without a playback id',
      event((e) => {
        e.type = 'intro.ended';
        e.data = { programId: 'main', parentPlaybackId: 'p' };
      }),
    ],
    [
      'an intro event without a parent id',
      event((e) => {
        e.type = 'intro.failed';
        e.data = { programId: 'main', playbackId: 'i' };
      }),
    ],
  ])('rejects %s', (_name, value) => {
    expect(parsePalazzoEvent(value)).toBeNull();
  });
});

// gaulatti/ariston#217: an unknown event type is its own frame kind, so the
// client can skip it without dropping the stream.
describe('classifyPalazzoFrame', () => {
  const frame = (type: unknown, data: unknown = {}) => ({
    schemaVersion: 1,
    id: 'evt-1',
    instanceId: 'inst',
    bootId: 'boot',
    sequence: 5,
    type,
    occurredAt: '2026-01-01T00:00:00.000Z',
    data,
  });

  it('returns a known event as an event', () => {
    expect(classifyPalazzoFrame(frame('heartbeat'))).toEqual({
      kind: 'event',
      event: frame('heartbeat'),
    });
  });

  it('returns a well-formed unknown type with its envelope only', () => {
    expect(classifyPalazzoFrame(frame('playout.new_thing', { x: 1 }))).toEqual({
      kind: 'unknown-type',
      envelope: {
        id: 'evt-1',
        instanceId: 'inst',
        bootId: 'boot',
        sequence: 5,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(parsePalazzoEvent(frame('playout.new_thing'))).toBeNull();
  });

  it.each([
    ['a non-string type', frame(5)],
    ['an empty type', frame('')],
    ['an overlong type', frame('x'.repeat(201))],
    ['an unknown type with array data', frame('playout.new_thing', [])],
    [
      'a fractional schema version',
      { ...frame('heartbeat'), schemaVersion: 1.1 },
    ],
    ['a string schema version', { ...frame('heartbeat'), schemaVersion: '1' }],
    ['a known type missing its fields', frame('track.started')],
  ])('returns %s as malformed', (_name, value) => {
    expect(classifyPalazzoFrame(value)).toEqual({ kind: 'malformed' });
  });
});

// gaulatti/ariston#217 slice 3: values Alcantara does not know degrade safely.
describe('Palazzo unknown values', () => {
  const collect = () => {
    const seen: string[] = [];
    return { seen, onUnknown: (field: string) => seen.push(field) };
  };

  it('reads an unknown availability as degraded and reports it', () => {
    const { seen, onUnknown } = collect();
    const parsed = parsePalazzoState(
      mutate((s) => (s.availability = 'maintenance')),
      { onUnknown },
    );
    expect(parsed?.availability).toBe('degraded');
    expect(seen).toEqual(['availability']);
  });

  it('keeps the previous status for an unknown one, else idle', () => {
    const { seen, onUnknown } = collect();
    const unknown = mutate((s) => (s.status = 'buffering'));
    expect(
      parsePalazzoState(unknown, { previousStatus: 'playing', onUnknown })
        ?.status,
    ).toBe('playing');
    expect(parsePalazzoState(unknown, { onUnknown })?.status).toBe('idle');
    expect(seen).toEqual(['status', 'status']);
  });

  it('reads an intro with an unknown status as no intro and keeps the state', () => {
    const { seen, onUnknown } = collect();
    const parsed = parsePalazzoState(
      mutate((s) => {
        s.intro = { ...validIntro(), status: 'queued' };
      }),
      { onUnknown },
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.intro).toBeNull();
    expect(seen).toEqual(['intro-status']);
  });

  it('reports nothing for known values', () => {
    const { seen, onUnknown } = collect();
    expect(
      parsePalazzoState(
        mutate(() => undefined),
        { onUnknown },
      ),
    ).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it.each([
    ['a non-string availability', mutate((s) => (s.availability = 1))],
    ['an empty availability', mutate((s) => (s.availability = ''))],
    ['an overlong status', mutate((s) => (s.status = 'x'.repeat(65)))],
    ['a missing status', mutate((s) => delete s.status)],
    [
      'a non-string intro status',
      mutate((s) => {
        s.intro = { ...validIntro(), status: 5 };
      }),
    ],
    ['another state schema major', mutate((s) => (s.schemaVersion = 2))],
  ])('still rejects %s', (_name, value) => {
    const { seen, onUnknown } = collect();
    expect(parsePalazzoState(value, { onUnknown })).toBeNull();
    expect(seen).toEqual([]);
  });

  it('skips an event of another integer major without reading it', () => {
    for (const schemaVersion of [0, 2, 3, 100]) {
      expect(classifyPalazzoFrame({ schemaVersion, type: 'whatever' })).toEqual(
        { kind: 'unsupported-version' },
      );
    }
  });

  it('rejects a withdrawn event with a non-string reason', () => {
    expect(
      classifyPalazzoFrame({
        schemaVersion: 1,
        id: 'e',
        instanceId: 'i',
        bootId: 'b',
        sequence: 1,
        type: 'playout.next_withdrawn',
        occurredAt: '2026-01-01T00:00:00.000Z',
        data: { playbackId: 'p', reason: 7 },
      }),
    ).toEqual({ kind: 'malformed' });
  });
});
