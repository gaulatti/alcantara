/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { generateRadioLog, parseRadioLogRules } from './radio-log-generator';
import { fillRadioRundown, parseFillerRules } from './radio-rundown-filler';
import './flight.types';

jest.mock('./radio-log-generator');
jest.mock('./radio-rundown-filler');

const mockedParseRules = parseRadioLogRules as jest.Mock;
const mockedGenerate = generateRadioLog as jest.Mock;
const mockedParseFiller = parseFillerRules as jest.Mock;
const mockedFill = fillRadioRundown as jest.Mock;

function minuteAt(offsetMs: number): string {
  const date = new Date(Date.now() + offsetMs);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function harness() {
  const prisma = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      update: jest.fn().mockResolvedValue({}),
    },
    flightSequence: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    song: { findMany: jest.fn().mockResolvedValue([]) },
    instant: { findMany: jest.fn().mockResolvedValue([]) },
    mediaLabel: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  };
  const program = {
    broadcastUpdate: jest.fn(),
  };
  const metrics = new RadioMetricsService();
  const recorded = jest.spyOn(metrics, 'recordRadioLogResult');
  const service = new FlightService(prisma as any, program as any, metrics);
  return {
    prisma,
    program,
    metrics,
    recorded,
    service,
    internals: service as any,
  };
}

const playable = {
  id: 1,
  enabled: true,
  audioUrl: 'https://media.test/1.mp3',
  durationMs: 1000,
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('FlightService cue normalization through the list boundary', () => {
  it('drops malformed cues and normalizes every supported field', async () => {
    const { prisma, service } = harness();
    prisma.flightSequence.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Full',
        loop: true,
        isRunning: true,
        activeItemId: 'a',
        scheduledAt: new Date('2030-01-01T00:00:00.000Z'),
        publishedAt: new Date('2030-01-01T00:00:00.000Z'),
        revision: 4,
        lastStartedAt: new Date('2030-01-01T00:00:00.000Z'),
        createdAt: new Date(0),
        updatedAt: new Date(1),
        items: [
          null,
          'text',
          [],
          { kind: 7 },
          { kind: 'warp' },
          {
            id: '  padded  ',
            kind: 'scene',
            label: '  Label  ',
            isFiller: true,
            clockOffsetSeconds: 10.6,
            voiceTrackInstantId: 4.2,
            voiceDuckGain: 0.5,
            voiceFadeInSeconds: 1,
            voiceFadeOutSeconds: 2,
            sceneId: 9,
            transitionId: ' fade ',
            songId: 5,
            durationMs: 0,
            metadataPatch: { a: 1 },
            instantId: 6,
            mixerChange: {
              channelId: 'sceneInstant',
              volume: 3.4,
              muted: true,
              solo: false,
            },
          },
          {
            id: '   ',
            kind: 'wait',
            label: '   ',
            isFiller: 'yes',
            clockOffsetSeconds: Infinity,
            voiceTrackInstantId: '4',
            voiceDuckGain: NaN,
            voiceFadeInSeconds: '1',
            voiceFadeOutSeconds: Infinity,
            sceneId: '9',
            transitionId: '  ',
            songId: null,
            durationMs: -5,
            metadataPatch: [1],
            instantId: NaN,
            mixerChange: {
              channelId: 'other',
              volume: 'loud',
              muted: 'yes',
              solo: 'no',
            },
          },
          { kind: 'mixer', durationMs: 25, mixerChange: { channelId: 'main' } },
          { kind: 'mixer', mixerChange: { channelId: 'song' } },
          { kind: 'mixer', mixerChange: { channelId: 'instants' } },
          { kind: 'mixer', mixerChange: { channelId: 'stream' } },
          { kind: 'mixer', mixerChange: [] },
          { id: 5, kind: 'stopSong' },
          { kind: 'sceneUpdate' },
          { kind: 'instant' },
          { kind: 'playSong' },
          { kind: 'waitForSongEnd' },
        ],
      },
      { id: 4, name: 'Bare', items: 'not-an-array', createdAt: 1 },
    ]);

    const result = await service.listFlightSequences(' radio-1 ');

    expect(prisma.programState.findUnique).toHaveBeenCalledWith({
      where: { programId: 'radio-1' },
    });
    expect(prisma.flightSequence.findMany).toHaveBeenCalledWith({
      where: { programStateId: 1 },
      orderBy: { createdAt: 'asc' },
    });
    const [full, bare] = result;
    expect(full).toMatchObject({
      id: 3,
      name: 'Full',
      loop: true,
      isRunning: true,
      activeItemId: 'a',
      revision: 4,
    });
    expect(full.items).toHaveLength(12);
    expect(full.items[0]).toEqual({
      id: 'padded',
      kind: 'scene',
      label: 'Label',
      isFiller: true,
      clockOffsetSeconds: 11,
      voiceTrackInstantId: 4,
      voiceDuckGain: 0.5,
      voiceFadeInSeconds: 1,
      voiceFadeOutSeconds: 2,
      sceneId: 9,
      transitionId: 'fade',
      songId: 5,
      durationMs: 0,
      metadataPatch: { a: 1 },
      instantId: 6,
      mixerChange: {
        channelId: 'sceneInstant',
        volume: 3,
        muted: true,
        solo: false,
      },
    });
    expect(full.items[1]).toEqual({
      id: expect.stringMatching(/^cue_/),
      kind: 'wait',
      label: undefined,
      mixerChange: {},
    });
    expect(full.items[2]).toMatchObject({
      kind: 'mixer',
      durationMs: 25,
      mixerChange: { channelId: 'main' },
    });
    expect(full.items.slice(3, 6).map((cue) => cue.mixerChange)).toEqual([
      { channelId: 'song' },
      { channelId: 'instants' },
      { channelId: 'stream' },
    ]);
    expect(full.items[6].mixerChange).toBeUndefined();
    expect(full.items[7].id).toMatch(/^cue_/);
    expect(full.items.map((cue) => cue.kind).slice(8)).toEqual([
      'sceneUpdate',
      'instant',
      'playSong',
      'waitForSongEnd',
    ]);
    expect(bare).toMatchObject({
      id: 4,
      items: [],
      scheduledAt: null,
      publishedAt: null,
      revision: 1,
      lastStartedAt: null,
    });
    expect(full.scheduledAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });

  it('rejects blank and non-string program IDs', async () => {
    const { service } = harness();
    await expect(service.listFlightSequences('   ')).rejects.toThrow(
      new BadRequestException('programId is required'),
    );
    await expect(service.listFlightSequences(7 as any)).rejects.toThrow(
      'programId is required',
    );
  });

  it('reports an unknown program as not found', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue(null);
    await expect(service.listFlightSequences('radio-1')).rejects.toThrow(
      new NotFoundException('program not found'),
    );
  });
});

describe('FlightService clocked log validation', () => {
  const song = (extra: Record<string, unknown> = {}) => ({
    id: 'a',
    kind: 'playSong',
    songId: 1,
    clockOffsetSeconds: 0,
    ...extra,
  });
  const validate = (items: unknown[]) =>
    harness().internals.validateClockItems(items);

  it('requires between 1 and 120 items', () => {
    expect(() => validate([])).toThrow('a clocked log needs 1-120 items');
    const many = Array.from({ length: 121 }, (_, i) => ({
      id: `c${i}`,
      kind: 'stopSong',
    }));
    expect(() => validate(many)).toThrow('a clocked log needs 1-120 items');
  });

  it('accepts a full valid log of every allowed kind', () => {
    expect(() =>
      validate([
        song({
          voiceTrackInstantId: 2,
          voiceDuckGain: 1,
          voiceFadeInSeconds: 0,
        }),
        { id: 'b', kind: 'instant', instantId: 3 },
        { id: 'c', kind: 'stopSong', clockOffsetSeconds: 10 },
        song({
          id: 'd',
          clockOffsetSeconds: 10,
          voiceTrackInstantId: 2,
          voiceFadeOutSeconds: 5,
        }),
      ]),
    ).not.toThrow();
  });

  it.each([
    [
      'duplicate IDs',
      [song(), song({ clockOffsetSeconds: undefined })],
      'log item IDs must be unique',
    ],
    [
      'unsupported kind',
      [song(), { id: 'b', kind: 'wait' }],
      'clocked logs support songs, clips, and stop cues',
    ],
    [
      'fractional offset',
      [song({ clockOffsetSeconds: 0.5 })],
      'fixed starts must be ordered from the block start',
    ],
    [
      'negative offset',
      [song(), { id: 'b', kind: 'stopSong', clockOffsetSeconds: -1 }],
      'fixed starts must be ordered from the block start',
    ],
    [
      'decreasing offset',
      [
        song({ clockOffsetSeconds: 0 }),
        { id: 'b', kind: 'stopSong', clockOffsetSeconds: 20 },
        { id: 'c', kind: 'stopSong', clockOffsetSeconds: 10 },
      ],
      'fixed starts must be ordered from the block start',
    ],
    [
      'first without offset',
      [song({ clockOffsetSeconds: undefined })],
      'the first event must start at the block start',
    ],
    [
      'first with nonzero offset',
      [song({ clockOffsetSeconds: 5 })],
      'the first event must start at the block start',
    ],
    [
      'song without catalog id',
      [song({ songId: undefined })],
      'each song cue needs a catalog song',
    ],
    [
      'song with zero id',
      [song({ songId: 0 })],
      'each song cue needs a catalog song',
    ],
    [
      'clip without id',
      [song(), { id: 'b', kind: 'instant' }],
      'each clip cue needs an audio clip',
    ],
    [
      'clip with zero id',
      [song(), { id: 'b', kind: 'instant', instantId: 0 }],
      'each clip cue needs an audio clip',
    ],
    [
      'voice track on non-song',
      [song(), { id: 'b', kind: 'stopSong', voiceTrackInstantId: 2 }],
      'a voice track must belong to a song cue',
    ],
    [
      'fractional voice track',
      [song({ voiceTrackInstantId: 1.5 })],
      'a voice track must belong to a song cue',
    ],
    [
      'zero voice track',
      [song({ voiceTrackInstantId: 0 })],
      'a voice track must belong to a song cue',
    ],
    [
      'duck gain without track',
      [song({ voiceDuckGain: 0.5 })],
      'voice mix settings need a recorded voice track',
    ],
    [
      'fade in without track',
      [song({ voiceFadeInSeconds: 1 })],
      'voice mix settings need a recorded voice track',
    ],
    [
      'fade out without track',
      [song({ voiceFadeOutSeconds: 1 })],
      'voice mix settings need a recorded voice track',
    ],
    [
      'duck gain below range',
      [song({ voiceTrackInstantId: 2, voiceDuckGain: -0.1 })],
      'voice duck gain must be between 0 and 1',
    ],
    [
      'duck gain above range',
      [song({ voiceTrackInstantId: 2, voiceDuckGain: 1.1 })],
      'voice duck gain must be between 0 and 1',
    ],
    [
      'negative fade in',
      [song({ voiceTrackInstantId: 2, voiceFadeInSeconds: -1 })],
      'voice fades must be between 0 and 5 seconds',
    ],
    [
      'long fade out',
      [song({ voiceTrackInstantId: 2, voiceFadeOutSeconds: 6 })],
      'voice fades must be between 0 and 5 seconds',
    ],
  ])('rejects %s', (_name, items, message) => {
    expect(() => validate(items as unknown[])).toThrow(
      new BadRequestException(message),
    );
  });
});

describe('FlightService clock item normalization', () => {
  const ok = { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 };
  const normalize = (value: unknown) =>
    harness().internals.normalizeClockItems(value);

  it('returns validated, normalized cues', () => {
    expect(
      normalize([
        {
          ...ok,
          isFiller: false,
          durationMs: 5,
          voiceTrackInstantId: 3,
          voiceDuckGain: 0.2,
          voiceFadeInSeconds: 1,
          voiceFadeOutSeconds: 1,
        },
      ]),
    ).toEqual([
      {
        id: 'a',
        kind: 'playSong',
        label: undefined,
        isFiller: false,
        durationMs: 5,
        songId: 1,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 3,
        voiceDuckGain: 0.2,
        voiceFadeInSeconds: 1,
        voiceFadeOutSeconds: 1,
      },
    ]);
  });

  it.each([
    ['a non-array', 'nope', 'items must be an array'],
    [
      'a non-record item',
      [null],
      'each log item needs an ID and supported cue kind',
    ],
    [
      'a non-string ID',
      [{ ...ok, id: 4 }],
      'each log item needs an ID and supported cue kind',
    ],
    [
      'a blank ID',
      [{ ...ok, id: '  ' }],
      'each log item needs an ID and supported cue kind',
    ],
    [
      'an unsupported kind',
      [{ ...ok, kind: 'wait' }],
      'each log item needs an ID and supported cue kind',
    ],
    [
      'a missing kind',
      [{ id: 'a' }],
      'each log item needs an ID and supported cue kind',
    ],
    [
      'a non-boolean filler flag',
      [{ ...ok, isFiller: 1 }],
      'isFiller must be boolean',
    ],
    [
      'a non-numeric duration',
      [{ ...ok, durationMs: '5' }],
      'durationMs must be positive',
    ],
    [
      'a non-finite duration',
      [{ ...ok, durationMs: Infinity }],
      'durationMs must be positive',
    ],
    [
      'a zero duration',
      [{ ...ok, durationMs: 0 }],
      'durationMs must be positive',
    ],
    [
      'a fractional clock offset',
      [{ ...ok, clockOffsetSeconds: 0.5 }],
      'clockOffsetSeconds must be a nonnegative integer',
    ],
    [
      'a negative song ID',
      [{ ...ok, songId: -1 }],
      'songId must be a nonnegative integer',
    ],
    [
      'a string instant ID',
      [{ ...ok, instantId: '1' }],
      'instantId must be a nonnegative integer',
    ],
    [
      'a negative voice track',
      [{ ...ok, voiceTrackInstantId: -2 }],
      'voiceTrackInstantId must be a nonnegative integer',
    ],
    [
      'a string duck gain',
      [{ ...ok, voiceDuckGain: '1' }],
      'voiceDuckGain must be a finite number',
    ],
    [
      'an infinite fade in',
      [{ ...ok, voiceFadeInSeconds: Infinity }],
      'voiceFadeInSeconds must be a finite number',
    ],
    [
      'a NaN fade out',
      [{ ...ok, voiceFadeOutSeconds: NaN }],
      'voiceFadeOutSeconds must be a finite number',
    ],
  ])('rejects %s', (_name, value, message) => {
    expect(() => normalize(value)).toThrow(new BadRequestException(message));
  });

  it('falls through to full validation after field checks', () => {
    expect(() => normalize([])).toThrow('a clocked log needs 1-120 items');
  });
});

describe('FlightService schedule parsing', () => {
  const parse = (value: unknown) => harness().internals.parseScheduledAt(value);

  it('treats null and undefined as unscheduled and parses minute-aligned ISO', () => {
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse('2030-05-06T07:08:00Z')).toEqual(
      new Date('2030-05-06T07:08:00.000Z'),
    );
    expect(parse('2030-05-06T07:08:00.000Z')).toEqual(
      new Date('2030-05-06T07:08:00.000Z'),
    );
  });

  it.each([
    ['a number', 12],
    ['a date-only string', '2030-05-06'],
    ['non-zero seconds', '2030-05-06T07:08:09Z'],
    ['a zone offset', '2030-05-06T07:08:00+01:00'],
  ])('rejects %s', (_name, value) => {
    expect(() => parse(value)).toThrow(
      new BadRequestException('scheduledAt must be an ISO time'),
    );
  });

  it.each([
    ['an impossible month', '2030-13-06T07:08:00Z'],
    ['a rolled-over day', '2030-02-31T07:08:00Z'],
  ])('rejects %s', (_name, value) => {
    expect(() => parse(value)).toThrow(
      new BadRequestException('scheduledAt is invalid'),
    );
  });
});

describe('FlightService clocked preflight', () => {
  const items = [
    { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
    {
      id: 'b',
      kind: 'instant',
      instantId: 7,
    },
    { id: 'c', kind: 'stopSong' },
  ];

  it('is ready when every referenced song and clip is playable', async () => {
    const { internals, prisma } = harness();
    prisma.song.findMany.mockResolvedValue([playable]);
    prisma.instant.findMany.mockResolvedValue([
      { id: 7, enabled: true, audioUrl: 'https://media.test/7.mp3' },
    ]);
    const result = await internals.preflightClockItems('radio-1', items);
    expect(result).toEqual({ programId: 'radio-1', ready: true, issues: [] });
    expect(prisma.song.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      select: { id: true, enabled: true, audioUrl: true, durationMs: true },
    });
    expect(prisma.instant.findMany).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
      select: { id: true, enabled: true, audioUrl: true },
    });
  });

  it('deduplicates ids and checks voice tracks as clips', async () => {
    const { internals, prisma } = harness();
    prisma.song.findMany.mockResolvedValue([playable]);
    prisma.instant.findMany.mockResolvedValue([
      { id: 7, enabled: true, audioUrl: 'x' },
    ]);
    await internals.preflightClockItems('radio-1', [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 1, voiceTrackInstantId: 7 },
      { id: 'c', kind: 'instant', instantId: 7 },
    ]);
    expect(prisma.song.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [1] },
    });
    expect(prisma.instant.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [7] },
    });
  });

  it.each([
    ['missing', []],
    ['disabled', [{ ...playable, enabled: false }]],
    ['blank', [{ ...playable, audioUrl: '   ' }]],
  ])('flags a %s song', async (_name, songs) => {
    const { internals, prisma } = harness();
    prisma.song.findMany.mockResolvedValue(songs);
    prisma.instant.findMany.mockResolvedValue([
      { id: 7, enabled: true, audioUrl: 'x' },
    ]);
    const result = await internals.preflightClockItems('radio-1', items);
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual(['Item 1: song unavailable']);
  });

  it.each([
    ['missing', []],
    ['disabled', [{ id: 7, enabled: false, audioUrl: 'x' }]],
    ['blank', [{ id: 7, enabled: true, audioUrl: ' ' }]],
  ])('flags a %s clip', async (_name, instants) => {
    const { internals, prisma } = harness();
    prisma.song.findMany.mockResolvedValue([playable]);
    prisma.instant.findMany.mockResolvedValue(instants);
    const result = await internals.preflightClockItems('radio-1', items);
    expect(result).toEqual({
      programId: 'radio-1',
      ready: false,
      issues: ['Item 2: audio clip unavailable'],
    });
  });

  it('validates the clock structure before querying', async () => {
    const { internals, prisma } = harness();
    await expect(internals.preflightClockItems('radio-1', [])).rejects.toThrow(
      'a clocked log needs 1-120 items',
    );
    expect(prisma.song.findMany).not.toHaveBeenCalled();
  });

  it('preflights a stored clocked log and rejects missing or unclocked ones', async () => {
    const { service, prisma } = harness();
    prisma.song.findMany.mockResolvedValue([playable]);
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(service.preflightFlightSequence('radio-1', 5)).rejects.toThrow(
      new NotFoundException('flight sequence not found'),
    );
    prisma.flightSequence.findFirst.mockResolvedValue({
      id: 5,
      scheduledAt: null,
      items: [],
    });
    await expect(service.preflightFlightSequence('radio-1', 5)).rejects.toThrow(
      new BadRequestException('not a clocked log'),
    );
    prisma.flightSequence.findFirst.mockResolvedValue({
      id: 5,
      scheduledAt: new Date(),
      items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
    });
    await expect(
      service.preflightFlightSequence('radio-1', 5),
    ).resolves.toEqual({ programId: 'radio-1', ready: true, issues: [] });
  });
});

describe('FlightService tagged log generation', () => {
  const future = () => new Date(Date.now() + 3_600_000);
  const draft = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    revision: 2,
    scheduledAt: future(),
    publishedAt: null,
    lastStartedAt: null,
    isRunning: false,
    ...extra,
  });
  const rules = {
    slots: [{ labelId: 'a' }, { labelId: 'b' }, { labelId: 'a' }],
    artistSeparation: 1,
  };

  it('rejects programs without a radio leg, counting the failure', async () => {
    const { service, prisma, recorded } = harness();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 2 }),
    ).rejects.toThrow(
      new BadRequestException('Radio logs require a radio leg'),
    );
    expect(recorded).toHaveBeenCalledWith('generation-failed');
  });

  it('accepts a both-leg program and reports a missing log', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'both' });
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 2 }),
    ).rejects.toThrow(new NotFoundException('radio log not found'));
  });

  it.each([
    ['unscheduled', { scheduledAt: null }],
    ['published', { publishedAt: new Date() }],
    ['already started', { lastStartedAt: new Date() }],
    ['running', { isRunning: true }],
  ])('refuses a %s block', async (_name, extra) => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft(extra));
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 2 }),
    ).rejects.toThrow(
      new BadRequestException(
        'Tag generation is available only for an unaired draft block',
      ),
    );
  });

  it('refuses a stale or missing revision', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft());
    await expect(
      service.generateTaggedLog('radio-1', 7, undefined as any),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 1 }),
    ).rejects.toThrow('The log changed. Reload before generating.');
  });

  it('generates from distinct labels with the newest-last history', async () => {
    const { service, prisma, recorded } = harness();
    const sequence = draft();
    prisma.flightSequence.findFirst.mockResolvedValue(sequence);
    mockedParseRules.mockReturnValue(rules);
    prisma.mediaLabel.findMany.mockResolvedValue([{ id: 'a', name: 'A' }]);
    prisma.song.findMany
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([playable]);
    prisma.flightSequence.findMany.mockResolvedValue([
      {
        items: [
          { id: 'n1', kind: 'playSong', songId: 30 },
          { id: 'n2', kind: 'playSong' },
          { id: 'n3', kind: 'stopSong', songId: 99 },
        ],
      },
      { items: [{ id: 'o1', kind: 'playSong', songId: 10 }] },
    ]);
    const generated = [
      { id: 'g', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
    ];
    mockedGenerate.mockReturnValue(generated);

    const result = await service.generateTaggedLog('radio-1', 7, {
      revision: 2,
      rules: 'raw-rules',
    });

    expect(mockedParseRules).toHaveBeenCalledWith('raw-rules');
    expect(prisma.mediaLabel.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
      select: { id: true, name: true },
    });
    expect(prisma.flightSequence.findMany).toHaveBeenCalledWith({
      where: {
        programStateId: 1,
        publishedAt: { not: null },
        scheduledAt: { lt: sequence.scheduledAt },
      },
      orderBy: { scheduledAt: 'desc' },
      take: 24,
      select: { items: true },
    });
    expect(mockedGenerate).toHaveBeenCalledWith(
      rules,
      [{ id: 1 }],
      [{ id: 'a', name: 'A' }],
      [10, 30],
    );
    expect(result).toEqual({ items: generated });
    expect(recorded).toHaveBeenCalledWith('generated');
    expect(recorded).not.toHaveBeenCalledWith('generation-failed');
  });

  it('fails when the generated items are not playable', async () => {
    const { service, prisma, recorded } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft());
    mockedParseRules.mockReturnValue(rules);
    prisma.song.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockedGenerate.mockReturnValue([
      { id: 'g', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
    ]);
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 2 }),
    ).rejects.toThrow(new BadRequestException('Item 1: song unavailable'));
    expect(recorded).toHaveBeenCalledWith('generation-failed');
    expect(recorded).not.toHaveBeenCalledWith('generated');
  });
});

describe('FlightService rundown filling', () => {
  const future = () => new Date(Date.now() + 3_600_000);
  const draft = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    revision: 2,
    scheduledAt: future(),
    publishedAt: null,
    lastStartedAt: null,
    isRunning: false,
    ...extra,
  });
  const items = [
    { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
    { id: 'b', kind: 'stopSong', clockOffsetSeconds: 60 },
  ];
  const input = { revision: 2, items, rules: 'raw' };

  it('rejects programs without a radio leg', async () => {
    const { service, prisma, recorded } = harness();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      new BadRequestException('Scheduled rundowns require a radio leg'),
    );
    expect(recorded).toHaveBeenCalledWith('fill-failed');
  });

  it('accepts a both-leg program and reports a missing rundown', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'both' });
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      new NotFoundException('rundown not found'),
    );
  });

  it.each([
    ['unscheduled', { scheduledAt: null }],
    ['published', { publishedAt: new Date() }],
    ['already started', { lastStartedAt: new Date() }],
    ['running', { isRunning: true }],
  ])('refuses a %s draft', async (_name, extra) => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft(extra));
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      new BadRequestException('Fill gaps only in an unaired unpublished draft'),
    );
  });

  it('refuses a stale or missing revision', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft());
    await expect(
      service.fillRundown('radio-1', 7, undefined as any),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.fillRundown('radio-1', 7, { ...input, revision: 9 }),
    ).rejects.toThrow('The rundown changed. Reload before filling.');
  });

  it('fills gaps, scoping song lookup to content and the filler tag', async () => {
    const { service, prisma, recorded } = harness();
    const sequence = draft();
    prisma.flightSequence.findFirst.mockResolvedValue(sequence);
    const rules = { labelId: 'music', artistSeparation: 0 };
    mockedParseFiller.mockReturnValue(rules);
    prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'music' });
    prisma.song.findMany
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([playable]);
    prisma.flightSequence.findMany.mockResolvedValue([
      {
        items: [
          { id: 'n1', kind: 'playSong', songId: 30 },
          { id: 'n2', kind: 'stopSong' },
        ],
      },
      { items: [{ id: 'o1', kind: 'playSong', songId: 10 }] },
    ]);
    const preview = {
      items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
      warnings: [],
    };
    mockedFill.mockReturnValue(preview);

    const result = await service.fillRundown('radio-1', 7, input);

    expect(mockedParseFiller).toHaveBeenCalledWith('raw');
    expect(prisma.mediaLabel.findUnique).toHaveBeenCalledWith({
      where: { id: 'music' },
    });
    expect(prisma.song.findMany.mock.calls[0][0].where).toEqual({
      enabled: true,
      audioUrl: { not: '' },
      OR: [
        { id: { in: [1] } },
        { asset: { labels: { some: { labelId: 'music' } } } },
      ],
    });
    expect(mockedFill).toHaveBeenCalledWith(
      rules,
      expect.any(Array),
      [{ id: 2 }],
      [10, 30],
    );
    expect(mockedFill.mock.calls[0][1].map((c: any) => c.id)).toEqual([
      'a',
      'b',
    ]);
    expect(result).toBe(preview);
    expect(recorded).toHaveBeenCalledWith('filled');
  });

  it('fails when the filler tag is gone or the preview is unplayable', async () => {
    const { service, prisma, recorded } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(draft());
    mockedParseFiller.mockReturnValue({
      labelId: 'music',
      artistSeparation: 0,
    });
    prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      new BadRequestException('Filler tag no longer exists'),
    );
    prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'music' });
    mockedFill.mockReturnValue({
      items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
      warnings: [],
    });
    prisma.song.findMany.mockResolvedValue([]);
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      new BadRequestException('Item 1: song unavailable'),
    );
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveBeenNthCalledWith(1, 'fill-failed');
    expect(recorded).toHaveBeenNthCalledWith(2, 'fill-failed');
  });
});

describe('FlightService publishing', () => {
  const clocked = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    revision: 3,
    loop: false,
    scheduledAt: new Date(Date.now() + 3_600_000),
    items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
    ...extra,
  });

  it('rejects programs without a radio leg and missing logs', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(new BadRequestException('program has no radio leg'));
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'both' });
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(new NotFoundException('flight sequence not found'));
  });

  it.each([
    ['unscheduled', { scheduledAt: null }],
    ['already due', { scheduledAt: new Date(Date.now() - 1000) }],
  ])('refuses a %s log', async (_name, extra) => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(clocked(extra));
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(
      new BadRequestException('the scheduled start must be in the future'),
    );
  });

  it('refuses looping and stale-revision logs', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(clocked({ loop: true }));
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(new BadRequestException('a clocked log cannot loop'));
    prisma.flightSequence.findFirst.mockResolvedValue(clocked());
    await expect(
      service.publishFlightSequence('radio-1', 7, 2),
    ).rejects.toThrow(
      new ConflictException('log revision changed; reload before publishing'),
    );
  });

  it('records a preflight failure and writes nothing', async () => {
    const { service, prisma, recorded } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(clocked());
    prisma.song.findMany.mockResolvedValue([]);
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(new BadRequestException('Item 1: song unavailable'));
    expect(recorded).toHaveBeenCalledWith('preflight-failed');
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });

  it('detects a concurrent revision change at write time', async () => {
    const { service, prisma, recorded } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(clocked());
    prisma.song.findMany.mockResolvedValue([playable]);
    prisma.flightSequence.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.publishFlightSequence('radio-1', 7, 3),
    ).rejects.toThrow(
      new ConflictException('log revision changed; reload before publishing'),
    );
    expect(prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { id: 7, revision: 3 },
      data: { publishedAt: expect.any(Date), revision: { increment: 1 } },
    });
    expect(recorded).not.toHaveBeenCalledWith('published');
  });
});

describe('FlightService sequence creation', () => {
  const clockItems = [
    { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
  ];

  it('rejects a missing or blank name', async () => {
    const { service } = harness();
    await expect(
      service.createFlightSequence('radio-1', { name: '   ' }),
    ).rejects.toThrow(
      new BadRequestException('flight sequence name is required'),
    );
    await expect(
      service.createFlightSequence('radio-1', { name: 4 as any }),
    ).rejects.toThrow('flight sequence name is required');
  });

  it('creates an unscheduled sequence with lenient item normalization', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.create.mockResolvedValue({
      id: 2,
      name: 'Plain',
      items: [],
      loop: true,
    });
    const result = await service.createFlightSequence(' radio-1 ', {
      name: ' Plain ',
      loop: true,
      items: [{ kind: 'wait', durationMs: 10, id: 'w' }, { kind: 'bogus' }],
    });
    expect(prisma.flightSequence.create).toHaveBeenCalledWith({
      data: {
        programStateId: 1,
        name: 'Plain',
        items: [{ id: 'w', kind: 'wait', label: undefined, durationMs: 10 }],
        loop: true,
        scheduledAt: null,
      },
    });
    expect(result.id).toBe(2);
  });

  it('defaults loop to false for non-true values', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.create.mockResolvedValue({ id: 2 });
    await service.createFlightSequence('radio-1', { name: 'N', loop: false });
    expect(prisma.flightSequence.create.mock.calls[0][0].data).toMatchObject({
      loop: false,
      items: [],
    });
  });

  it('validates clocked items strictly when a start time is given', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.create.mockResolvedValue({ id: 2 });
    const scheduledAt = minuteAt(3_600_000);
    await service.createFlightSequence('radio-1', {
      name: 'Hour',
      scheduledAt,
      items: clockItems,
    });
    expect(prisma.flightSequence.create.mock.calls[0][0].data).toMatchObject({
      scheduledAt: new Date(scheduledAt),
      items: [expect.objectContaining({ id: 'a', songId: 1 })],
    });
    await expect(
      service.createFlightSequence('radio-1', {
        name: 'Hour2',
        scheduledAt,
        items: [{ id: 'x', kind: 'wait' }],
      }),
    ).rejects.toThrow('each log item needs an ID and supported cue kind');
  });

  it('allows an empty clocked draft', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.create.mockResolvedValue({ id: 2 });
    const scheduledAt = minuteAt(3_600_000);
    await service.createFlightSequence('radio-1', {
      name: 'Empty',
      scheduledAt,
      items: [],
    });
    await service.createFlightSequence('radio-1', {
      name: 'NoItems',
      scheduledAt,
    });
    expect(prisma.flightSequence.create.mock.calls[0][0].data.items).toEqual(
      [],
    );
    expect(prisma.flightSequence.create.mock.calls[1][0].data.items).toEqual(
      [],
    );
  });

  it('rejects a clocked log on a program without a radio leg or with looping', async () => {
    const { service, prisma } = harness();
    const scheduledAt = minuteAt(3_600_000);
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(
      service.createFlightSequence('radio-1', { name: 'A', scheduledAt }),
    ).rejects.toThrow(new BadRequestException('program has no radio leg'));
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'both' });
    await expect(
      service.createFlightSequence('radio-1', {
        name: 'A',
        scheduledAt,
        loop: true,
      }),
    ).rejects.toThrow(new BadRequestException('a clocked log cannot loop'));
    expect(prisma.flightSequence.create).not.toHaveBeenCalled();
  });

  it('maps duplicate-key errors differently for clocked and plain logs', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.createFlightSequence('radio-1', {
        name: 'Hour',
        scheduledAt: minuteAt(3_600_000),
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'a radio log already exists for this scheduled start or name',
      ),
    );
    await expect(
      service.createFlightSequence('radio-1', { name: 'Plain' }),
    ).rejects.toThrow(
      new BadRequestException('flight sequence "Plain" already exists'),
    );
  });

  it('rethrows unexpected persistence errors unchanged', async () => {
    const { service, prisma } = harness();
    const failure = Object.assign(new Error('db down'), { code: 'P1001' });
    prisma.flightSequence.create.mockRejectedValue(failure);
    await expect(
      service.createFlightSequence('radio-1', { name: 'Plain' }),
    ).rejects.toBe(failure);
    prisma.flightSequence.create.mockRejectedValue(null);
    await expect(
      service.createFlightSequence('radio-1', { name: 'Plain' }),
    ).rejects.toBeNull();
  });
});

describe('FlightService active sequence lookup', () => {
  it('returns null without an active sequence id or state', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue(null);
    await expect(
      service.getActiveFlightSequence('radio-1'),
    ).resolves.toBeNull();
    prisma.programState.findUnique.mockResolvedValue({
      id: 1,
      activeFlightSequenceId: null,
    });
    await expect(
      service.getActiveFlightSequence('radio-1'),
    ).resolves.toBeNull();
    expect(prisma.flightSequence.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the active sequence was deleted', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue({
      id: 1,
      activeFlightSequenceId: 9,
    });
    prisma.flightSequence.findUnique.mockResolvedValue(null);
    await expect(
      service.getActiveFlightSequence('radio-1'),
    ).resolves.toBeNull();
    expect(prisma.flightSequence.findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
    });
  });

  it('returns the active id with the mapped sequence', async () => {
    const { service, prisma } = harness();
    prisma.programState.findUnique.mockResolvedValue({
      id: 1,
      activeFlightSequenceId: 9,
    });
    prisma.flightSequence.findUnique.mockResolvedValue({
      id: 9,
      name: 'Active',
      items: [{ id: 'w', kind: 'wait' }],
    });
    const result = await service.getActiveFlightSequence('radio-1');
    expect(result?.activeSequenceId).toBe(9);
    expect(result?.sequence).toMatchObject({
      id: 9,
      name: 'Active',
      items: [{ id: 'w', kind: 'wait', label: undefined }],
    });
  });
});

describe('FlightService scheduled start polling', () => {
  const due = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    programState: { programId: `radio-${id}` },
    items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
    ...extra,
  });

  it('polls once a second after init and clears the timer on destroy', async () => {
    jest.useFakeTimers();
    const { service, prisma, recorded } = harness();
    (prisma.flightSequence as any).updateMany.mockResolvedValue({ count: 0 });
    const poll = jest
      .spyOn(service as any, 'startDuePublishedLogs')
      .mockResolvedValue(undefined);
    await service.onModuleInit();
    expect(recorded).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(3);
    service.onModuleDestroy();
    jest.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('destroys cleanly before init and clears runtime timers', () => {
    jest.useFakeTimers();
    const { service, internals } = harness();
    const timer = setTimeout(() => undefined, 1000);
    internals.runtimes.set('a', { timer });
    internals.runtimes.set('b', { timer: null });
    service.onModuleDestroy();
    expect(internals.runtimes.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not overlap polls', async () => {
    const { internals, prisma } = harness();
    internals.scheduleTickRunning = true;
    await internals.startDuePublishedLogs();
    expect(prisma.flightSequence.findMany).not.toHaveBeenCalled();
    expect(internals.scheduleTickRunning).toBe(true);
  });

  it('records a poll failure without leaking details and releases the guard', async () => {
    const { internals, prisma, recorded } = harness();
    const logged = jest
      .spyOn(internals.logger, 'error')
      .mockImplementation(() => undefined);
    prisma.flightSequence.findMany.mockRejectedValue(new Error('secret'));
    await internals.startDuePublishedLogs();
    expect(recorded).toHaveBeenCalledWith('poll-failed');
    expect(logged).toHaveBeenCalledWith('Scheduled radio log poll failed');
    expect(internals.scheduleTickRunning).toBe(false);
  });

  it('starts claimed blocks and reports failures without retrying', async () => {
    const { service, internals, prisma, program, recorded } = harness();
    prisma.flightSequence.findMany.mockResolvedValue([
      due(1),
      due(2),
      due(3),
      due(4),
    ]);
    prisma.flightSequence.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    prisma.song.findMany
      .mockResolvedValueOnce([playable])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([playable]);
    const activate = jest
      .spyOn(service, 'activateFlightSequence')
      .mockResolvedValueOnce({ activeSequenceId: 2 })
      .mockRejectedValueOnce(new Error('activation failed'));
    const start = jest.spyOn(service, 'start').mockResolvedValue({ ok: true });

    await internals.startDuePublishedLogs();

    expect(prisma.flightSequence.findMany).toHaveBeenCalledWith({
      where: {
        publishedAt: { not: null },
        lastStartedAt: null,
        scheduledAt: { gte: expect.any(Date), lte: expect.any(Date) },
      },
      include: { programState: { select: { programId: true } } },
      take: 20,
    });
    expect(prisma.flightSequence.updateMany).toHaveBeenCalledTimes(4);
    expect(prisma.flightSequence.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 1, lastStartedAt: null, publishedAt: { not: null } },
      data: { lastStartedAt: expect.any(Date) },
    });
    expect(activate).toHaveBeenCalledWith('radio-2', 2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('radio-2');
    expect(
      recorded.mock.calls.filter(([r]) => r === 'start-failed'),
    ).toHaveLength(2);
    expect(program.broadcastUpdate).toHaveBeenCalledWith('radio-3', {
      type: 'radio_log_start_failed',
      sequenceId: 3,
    });
    expect(program.broadcastUpdate).toHaveBeenCalledWith('radio-4', {
      type: 'radio_log_start_failed',
      sequenceId: 4,
    });
    expect(program.broadcastUpdate).not.toHaveBeenCalledWith(
      'radio-1',
      expect.anything(),
    );
    expect(internals.scheduleTickRunning).toBe(false);
  });
});
