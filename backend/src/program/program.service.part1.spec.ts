/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the spec drives private members of ProgramService. */
import { BadRequestException } from '@nestjs/common';
import { ProgramService } from './program.service';

type AnyRecord = Record<string, any>;

const DEFAULT_CHANNELS = [
  { id: 'song', name: 'Song', volume: 1, muted: false, solo: false },
  { id: 'stream', name: 'Stream', volume: 1, muted: false, solo: false },
  { id: 'instants', name: 'Instants', volume: 1, muted: false, solo: false },
  {
    id: 'sceneInstant',
    name: 'Scene Instant',
    volume: 1,
    muted: false,
    solo: false,
  },
];

const buildBroadcastRow = (overrides: AnyRecord = {}) => ({
  id: 1,
  timeOverrideEnabled: false,
  timeOverrideStartTime: null,
  timeOverrideStartedAt: null,
  mixerChannels: DEFAULT_CHANNELS,
  mainMasterVolume: 1,
  songMasterVolume: 1,
  instantMasterVolume: 1,
  streamMasterVolume: 1,
  songMuted: false,
  instantMuted: false,
  streamMuted: false,
  songSolo: false,
  instantSolo: false,
  streamSolo: false,
  ...overrides,
});

describe('ProgramService part 1 (settings, versions, state lookup)', () => {
  const build = (withOutputConfidence = true) => {
    const prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      programState: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
      broadcastSettings: { upsert: jest.fn() },
    };
    const engine = { setBroadcastHandler: jest.fn() };
    const outputConfidence = { observe: jest.fn() };
    const service = new ProgramService(
      prisma as never,
      {} as never,
      engine as never,
      undefined,
      withOutputConfidence ? (outputConfidence as never) : undefined,
    );
    return { service, prisma, engine, outputConfidence, svc: service as any };
  };

  /** Upsert mock: no-op update returns `current`, real update echoes the data. */
  const mockBroadcastUpsert = (
    prisma: ReturnType<typeof build>['prisma'],
    current: AnyRecord,
  ) => {
    prisma.broadcastSettings.upsert.mockImplementation((args: AnyRecord) =>
      Promise.resolve(
        Object.keys(args.update).length === 0
          ? current
          : { id: 1, ...args.update },
      ),
    );
  };

  describe('onModuleInit', () => {
    it('fails fast when the output confidence service is missing', async () => {
      const { service, engine, prisma } = build(false);
      await expect(service.onModuleInit()).rejects.toThrow(
        'Radio output confidence service is required',
      );
      expect(engine.setBroadcastHandler).not.toHaveBeenCalled();
      expect(prisma.programState.upsert).not.toHaveBeenCalled();
    });

    it('registers the engine handler and seeds the default program', async () => {
      const { service, engine, prisma, outputConfidence } = build();
      await service.onModuleInit();

      expect(prisma.programState.upsert).toHaveBeenCalledWith({
        where: { programId: 'main' },
        update: {},
        create: {
          programId: 'main',
          activeSceneId: null,
          audioMixer: {
            mainMasterVolume: 1,
            songMasterVolume: 1,
            instantMasterVolume: 1,
            sceneInstantMasterVolume: 1,
            streamMasterVolume: 1,
            songMuted: false,
            instantMuted: false,
            sceneInstantMuted: false,
            streamMuted: false,
            songSolo: false,
            instantSolo: false,
            sceneInstantSolo: false,
            streamSolo: false,
            mixerChannels: DEFAULT_CHANNELS,
          },
        },
      });

      const handler = engine.setBroadcastHandler.mock.calls[0][0];
      const received: AnyRecord[] = [];
      service.addEventListener((event) => received.push(event));
      const event = {
        type: 'song_off_air',
        programId: 'main',
        triggeredAt: '2026-01-01T00:00:00.000Z',
      };
      handler(event);

      expect(outputConfidence.observe).toHaveBeenCalledWith(event);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        scope: 'program',
        programId: 'main',
        data: { type: 'song_off_air', version: 1 },
      });
    });
  });

  describe('scene instant playback placeholder', () => {
    it('creates an empty epoch-stamped playback for a program', () => {
      const { svc } = build();
      expect(svc.createEmptyProgramSceneInstantPlayback('abc')).toEqual({
        programId: 'abc',
        sceneId: null,
        instantId: null,
        mediaAssetId: null,
        isPlaying: false,
        instant: null,
        startedAt: null,
        updatedAt: '1970-01-01T00:00:00.000Z',
      });
    });
  });

  describe('mixer coercion helpers', () => {
    it('keeps booleans and falls back for anything else', () => {
      const { svc } = build();
      expect(svc.coerceMixerToggle(true, false)).toBe(true);
      expect(svc.coerceMixerToggle(false, true)).toBe(false);
      expect(svc.coerceMixerToggle('yes', true)).toBe(true);
      expect(svc.coerceMixerToggle(undefined, false)).toBe(false);
    });

    it('returns the fallback channel when none matches the id', () => {
      const { svc } = build();
      const channels = [
        { id: 'a', name: 'A', volume: 0.2, muted: true, solo: true },
      ];
      expect(svc.getBroadcastMixerChannel(channels, 'a')).toBe(channels[0]);
      expect(svc.getBroadcastMixerChannel(channels, 'zzz')).toEqual({
        id: 'zzz',
        name: 'zzz',
        volume: 1,
        muted: false,
        solo: false,
      });
    });

    it('restores the default channels when the stored and fallback channel lists are empty', () => {
      const { svc } = build();
      const resolved = svc.withResolvedProgramAudioMixerSettings(
        { mixerChannels: [] },
        { ...svc.createDefaultProgramAudioMixerSettings(), mixerChannels: [] },
      );
      expect(resolved.mixerChannels).toEqual(DEFAULT_CHANNELS);
      expect(resolved.songMasterVolume).toBe(1);
      expect(resolved.streamMuted).toBe(false);
      expect(resolved.sceneInstantSolo).toBe(false);
    });
  });

  describe('normalizeBroadcastMixerChannels', () => {
    it('returns the fallback when the value is not an array', () => {
      const { svc } = build();
      expect(
        svc.normalizeBroadcastMixerChannels('nope', DEFAULT_CHANNELS),
      ).toBe(DEFAULT_CHANNELS);
    });

    it('skips malformed entries and merges valid ones over the fallback', () => {
      const { svc } = build();
      const result = svc.normalizeBroadcastMixerChannels(
        [
          null,
          'text',
          ['array'],
          { id: 42 },
          { id: '   ' },
          { id: ' song ', name: '  Lead  ', volume: 2, muted: true, solo: 'x' },
          { id: 'stream', name: '   ', volume: -3, muted: 'no' },
          { id: 'extra' },
          {
            id: 'extra2',
            name: 'Named',
            volume: 0.25,
            muted: true,
            solo: true,
          },
        ],
        DEFAULT_CHANNELS,
      );
      expect(result).toEqual([
        { id: 'song', name: 'Lead', volume: 1, muted: true, solo: false },
        { id: 'stream', name: 'Stream', volume: 0, muted: false, solo: false },
        {
          id: 'instants',
          name: 'Instants',
          volume: 1,
          muted: false,
          solo: false,
        },
        {
          id: 'sceneInstant',
          name: 'Scene Instant',
          volume: 1,
          muted: false,
          solo: false,
        },
        { id: 'extra', name: 'extra', volume: 1, muted: false, solo: false },
        { id: 'extra2', name: 'Named', volume: 0.25, muted: true, solo: true },
      ]);
    });
  });

  describe('getBroadcastSettings', () => {
    it('ensures columns once, upserts defaults and resolves legacy fields into channels', async () => {
      const { service, prisma } = build();
      prisma.broadcastSettings.upsert.mockResolvedValue({
        id: 1,
        timeOverrideEnabled: false,
        mixerChannels: null,
        songMasterVolume: 0.5,
        songMuted: true,
        songSolo: 'bad',
        streamMasterVolume: 5,
        streamMuted: 'bad',
        streamSolo: true,
        instantMasterVolume: 'bad',
        sceneInstantMasterVolume: Number.NaN,
        sceneInstantMuted: true,
      });

      const first: AnyRecord = await service.getBroadcastSettings();
      await service.getBroadcastSettings();

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toContain(
        'ALTER TABLE "BroadcastSettings"',
      );
      expect(prisma.broadcastSettings.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        update: {},
        create: expect.objectContaining({
          id: 1,
          timeOverrideEnabled: false,
          mixerChannels: DEFAULT_CHANNELS,
          mainMasterVolume: 1,
          streamSolo: false,
        }),
      });
      expect(first).toMatchObject({
        version: 0,
        songMasterVolume: 0.5,
        songMuted: true,
        songSolo: false,
        streamMasterVolume: 1,
        streamMuted: false,
        streamSolo: true,
        instantMasterVolume: 1,
        sceneInstantMasterVolume: 1,
        sceneInstantMuted: true,
        sceneInstantSolo: false,
      });
      expect(first.mixerChannels).toEqual([
        { id: 'song', name: 'Song', volume: 0.5, muted: true, solo: false },
        { id: 'stream', name: 'Stream', volume: 1, muted: false, solo: true },
        {
          id: 'instants',
          name: 'Instants',
          volume: 1,
          muted: false,
          solo: false,
        },
        {
          id: 'sceneInstant',
          name: 'Scene Instant',
          volume: 1,
          muted: true,
          solo: false,
        },
      ]);
    });
  });

  describe('updateBroadcastSettings', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the current settings untouched when nothing is requested', async () => {
      const { service, prisma } = build();
      const row = buildBroadcastRow({
        mixerChannels: [{ id: 'song', name: 'Song', volume: 0.3 }],
      });
      mockBroadcastUpsert(prisma, row);

      const result: AnyRecord = await service.updateBroadcastSettings({});

      expect(prisma.broadcastSettings.upsert).toHaveBeenCalledTimes(1);
      expect(result.songMasterVolume).toBe(0.3);
      expect(result).not.toHaveProperty('version');
    });

    it('enables the time override, resets startedAt and broadcasts a versioned global update', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
      const { service, prisma } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());
      const events: AnyRecord[] = [];
      service.addEventListener((event) => events.push(event));

      const result: AnyRecord = await service.updateBroadcastSettings({
        enabled: true,
        startTime: ' 07:30 ',
      });

      const call = prisma.broadcastSettings.upsert.mock.calls[1][0];
      expect(call.update).toMatchObject({
        timeOverrideEnabled: true,
        timeOverrideStartTime: '07:30',
        timeOverrideStartedAt: new Date('2026-03-04T05:06:07.000Z'),
        mainMasterVolume: 1,
      });
      expect(call.create.id).toBe(1);
      expect(result.version).toBe(1);
      expect(result.timeOverrideStartTime).toBe('07:30');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        scope: 'global',
        programId: null,
        data: { type: 'broadcast_settings_update', version: 1 },
      });
      expect(service.getGlobalBroadcastVersion()).toBe(1);
    });

    it('falls back to the global version if the broadcast payload has no numeric version', async () => {
      const { service, prisma, svc } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());
      jest.spyOn(svc, 'broadcastGlobalUpdate').mockReturnValue(undefined);

      const result: AnyRecord = await service.updateBroadcastSettings({
        mainMasterVolume: 0.5,
      });

      expect(result.version).toBe(0);
    });

    it('rejects enabling without any start time', async () => {
      const { service, prisma } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());
      await expect(
        service.updateBroadcastSettings({ enabled: true, startTime: '   ' }),
      ).rejects.toThrow(
        new BadRequestException(
          'startTime is required when enabling time override',
        ),
      );
      expect(prisma.broadcastSettings.upsert).toHaveBeenCalledTimes(1);
    });

    it.each(['7:30', '24:00', '12:60', 'noon'])(
      'rejects malformed start time %s',
      async (startTime) => {
        const { service, prisma } = build();
        mockBroadcastUpsert(prisma, buildBroadcastRow());
        await expect(
          service.updateBroadcastSettings({ enabled: true, startTime }),
        ).rejects.toThrow('startTime must be in HH:mm format');
      },
    );

    it('reuses the stored start time when enabling with a blank one', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
      const { service, prisma } = build();
      mockBroadcastUpsert(
        prisma,
        buildBroadcastRow({
          timeOverrideStartTime: '08:15',
          timeOverrideStartedAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      );

      await service.updateBroadcastSettings({ enabled: true });

      const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
      expect(update.timeOverrideStartTime).toBe('08:15');
      expect(update.timeOverrideStartedAt).toEqual(
        new Date('2026-05-01T00:00:00.000Z'),
      );
    });

    describe('while already enabled', () => {
      const startedAt = new Date('2020-01-01T00:00:00.000Z');
      const enabledRow = (overrides: AnyRecord = {}) =>
        buildBroadcastRow({
          timeOverrideEnabled: true,
          timeOverrideStartTime: '08:15',
          timeOverrideStartedAt: startedAt,
          ...overrides,
        });

      it('restarts the clock when the start time changes', async () => {
        jest
          .useFakeTimers()
          .setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
        const { service, prisma } = build();
        mockBroadcastUpsert(prisma, enabledRow());
        await service.updateBroadcastSettings({ startTime: '09:00' });
        const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
        expect(update.timeOverrideStartTime).toBe('09:00');
        expect(update.timeOverrideStartedAt).toEqual(
          new Date('2026-06-01T00:00:00.000Z'),
        );
      });

      it('keeps the clock when the start time is unchanged', async () => {
        const { service, prisma } = build();
        mockBroadcastUpsert(prisma, enabledRow());
        await service.updateBroadcastSettings({ startTime: '08:15' });
        const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
        expect(update.timeOverrideStartedAt).toBe(startedAt);
      });

      it('keeps the clock when only unrelated settings change', async () => {
        const { service, prisma } = build();
        mockBroadcastUpsert(prisma, enabledRow());
        await service.updateBroadcastSettings({ songMuted: true });
        const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
        expect(update.timeOverrideStartTime).toBe('08:15');
        expect(update.timeOverrideStartedAt).toBe(startedAt);
      });

      it('creates a start timestamp when none was stored', async () => {
        jest
          .useFakeTimers()
          .setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
        const { service, prisma } = build();
        mockBroadcastUpsert(
          prisma,
          enabledRow({ timeOverrideStartedAt: null }),
        );
        await service.updateBroadcastSettings({ songMuted: false });
        const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
        expect(update.timeOverrideStartedAt).toEqual(
          new Date('2026-07-01T00:00:00.000Z'),
        );
      });

      it('clears the override when disabled', async () => {
        const { service, prisma } = build();
        mockBroadcastUpsert(prisma, enabledRow());
        await service.updateBroadcastSettings({ enabled: false });
        const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
        expect(update).toMatchObject({
          timeOverrideEnabled: false,
          timeOverrideStartTime: null,
          timeOverrideStartedAt: null,
        });
      });
    });

    it('applies volumes (clamped), toggles and channel replacements to the persisted channels', async () => {
      const { service, prisma } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());

      const result: AnyRecord = await service.updateBroadcastSettings({
        mixerChannels: [{ id: 'custom', name: 'Custom', volume: 0.4 }],
        mainMasterVolume: 3,
        songMasterVolume: 0.1,
        instantMasterVolume: -1,
        streamMasterVolume: 0.7,
        sceneInstantMasterVolume: 0.9,
        songMuted: true,
        instantMuted: true,
        streamMuted: true,
        sceneInstantMuted: true,
        songSolo: true,
        instantSolo: true,
        streamSolo: true,
        sceneInstantSolo: true,
      });

      const { update } = prisma.broadcastSettings.upsert.mock.calls[1][0];
      expect(update).toMatchObject({
        mainMasterVolume: 1,
        songMasterVolume: 0.1,
        instantMasterVolume: 0,
        streamMasterVolume: 0.7,
        songMuted: true,
        instantMuted: true,
        streamMuted: true,
        songSolo: true,
        instantSolo: true,
        streamSolo: true,
      });
      expect(update.mixerChannels).toEqual([
        { id: 'song', name: 'Song', volume: 0.1, muted: true, solo: true },
        { id: 'stream', name: 'Stream', volume: 0.7, muted: true, solo: true },
        {
          id: 'instants',
          name: 'Instants',
          volume: 0,
          muted: true,
          solo: true,
        },
        {
          id: 'sceneInstant',
          name: 'Scene Instant',
          volume: 0.9,
          muted: true,
          solo: true,
        },
        {
          id: 'custom',
          name: 'Custom',
          volume: 0.4,
          muted: false,
          solo: false,
        },
      ]);
      expect(result).toMatchObject({
        sceneInstantMasterVolume: 0.9,
        sceneInstantMuted: true,
        sceneInstantSolo: true,
        mainMasterVolume: 1,
      });
    });

    it.each([
      'mainMasterVolume',
      'songMasterVolume',
      'instantMasterVolume',
      'streamMasterVolume',
      'sceneInstantMasterVolume',
    ])('rejects a non-finite %s', async (field) => {
      const { service, prisma } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());
      for (const bad of ['0.5', Number.NaN, Infinity]) {
        await expect(
          service.updateBroadcastSettings({ [field]: bad } as never),
        ).rejects.toThrow(
          new BadRequestException(`${field} must be a finite number`),
        );
      }
    });

    it.each([
      'songMuted',
      'instantMuted',
      'streamMuted',
      'sceneInstantMuted',
      'songSolo',
      'instantSolo',
      'streamSolo',
      'sceneInstantSolo',
    ])('rejects a non-boolean %s', async (field) => {
      const { service, prisma } = build();
      mockBroadcastUpsert(prisma, buildBroadcastRow());
      await expect(
        service.updateBroadcastSettings({ [field]: 'true' } as never),
      ).rejects.toThrow(new BadRequestException(`${field} must be a boolean`));
      expect(prisma.broadcastSettings.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('versioned program events', () => {
    it.each([
      ['scene_change', 'state'],
      ['scene_staged', 'state'],
      ['scene_update', 'state'],
      ['scene_cleared', 'state'],
      ['program_scenes_changed', 'state'],
      ['program_media_groups_changed', 'state'],
      ['program_stingers_changed', 'state'],
      ['audio_bus_update', 'audioBus'],
      ['song_queue_update', 'audioBus'],
      ['audio_meter_update', 'audioMeter'],
      ['song_playback_update', 'songPlayback'],
      ['song_off_air', 'songPlayback'],
      ['scene_instant_take', 'sceneInstant'],
      ['scene_instant_stop', 'sceneInstant'],
      ['scene_instant_state', 'sceneInstant'],
      ['flight_update', 'flight'],
    ] as const)('%s bumps only the %s topic version', (type, topic) => {
      const { service } = build();
      const first = service.broadcastUpdate(' p1 ', { type });
      const second = service.broadcastUpdate('p1', { type });
      expect(first).toEqual({ type, version: 1 });
      expect(second).toEqual({ type, version: 2 });
      expect(service.getProgramUpdateVersion(' p1 ', topic)).toBe(2);
      expect(service.getProgramUpdateVersion('other', topic)).toBe(0);
    });

    it.each([
      ['unknown event type', { type: 'something_else', a: 1 }],
      ['blank event type', { type: '   ' }],
      ['missing event type', { a: 1 }],
      ['non-string event type', { type: 5 }],
    ])('leaves a payload with %s unversioned', (_label, payload) => {
      const { service } = build();
      expect(service.broadcastUpdate('p1', payload)).toEqual(payload);
      expect(service.getProgramUpdateVersion('p1', 'state')).toBe(0);
    });

    it.each([
      ['string', 'plain'],
      ['null', null],
      ['array', [{ type: 'scene_change' }]],
    ])('passes a %s payload through unchanged', (_label, payload) => {
      const { service } = build();
      expect(service.broadcastUpdate('p1', payload)).toEqual(payload);
      expect(service.getProgramUpdateVersion('p1', 'state')).toBe(0);
    });

    it('defaults to the main program and rejects blank program ids', () => {
      const { service } = build();
      service.broadcastUpdate(undefined, { type: 'audio_bus_update' });
      expect(
        service.getProgramUpdateVersion(undefined as never, 'audioBus'),
      ).toBe(1);
      expect(service.getProgramUpdateVersion('main', 'audioBus')).toBe(1);
      expect(() => service.getProgramUpdateVersion('  ', 'state')).toThrow(
        'programId is required',
      );
      expect(() =>
        service.broadcastUpdate('', { type: 'scene_change' }),
      ).toThrow('programId is required');
    });

    it('delivers program updates to subscribed subjects and listeners until unsubscribed', () => {
      const { service, svc } = build();
      const received: AnyRecord[] = [];
      const off = service.addEventListener((event) => received.push(event));
      const throwing = service.addEventListener(() => {
        throw new Error('listener failure');
      });
      const subjectEvents: AnyRecord[] = [];
      svc
        .getEventSubject('p1')
        .subscribe((e: AnyRecord) => subjectEvents.push(e));
      expect(svc.getEventSubject('p1')).toBe(svc.getEventSubject('p1'));

      service.broadcastUpdate('p1', { type: 'scene_change' });
      off();
      throwing();
      service.broadcastUpdate('p1', { type: 'scene_change' });

      expect(received).toEqual([
        {
          scope: 'program',
          programId: 'p1',
          data: { type: 'scene_change', version: 1 },
        },
      ]);
      expect(subjectEvents.map((e) => e.version)).toEqual([1, 2]);
    });
  });

  describe('withProgramVersionEnvelope options', () => {
    it('bumps the topic version when no options are given', () => {
      const { svc, service } = build();
      expect(
        svc.withProgramVersionEnvelope('p1', { type: 'scene_change' }),
      ).toEqual({
        type: 'scene_change',
        version: 1,
      });
      expect(service.getProgramUpdateVersion('p1', 'state')).toBe(1);
    });

    it('reports the current topic version without bumping when asked not to', () => {
      const { svc, service } = build();
      svc.withProgramVersionEnvelope('p1', { type: 'scene_change' });
      expect(
        svc.withProgramVersionEnvelope(
          'p1',
          { type: 'scene_change' },
          { bumpVersion: false },
        ),
      ).toEqual({ type: 'scene_change', version: 1 });
      expect(service.getProgramUpdateVersion('p1', 'state')).toBe(1);
    });
  });

  describe('global version envelope', () => {
    it('bumps by default and wraps non-object payloads', () => {
      const { svc } = build();
      expect(svc.withGlobalVersionEnvelope({ type: 'x' })).toEqual({
        type: 'x',
        version: 1,
      });
      expect(svc.withGlobalVersionEnvelope('text')).toEqual({
        type: 'global_update',
        payload: 'text',
        version: 2,
      });
      expect(
        svc.withGlobalVersionEnvelope(null, { bumpVersion: true }),
      ).toEqual({
        type: 'global_update',
        payload: null,
        version: 3,
      });
      expect(svc.withGlobalVersionEnvelope([1])).toEqual({
        type: 'global_update',
        payload: [1],
        version: 4,
      });
      expect(svc.getGlobalBroadcastVersion()).toBe(4);
    });

    it('reports without bumping when asked not to', () => {
      const { service, svc } = build();
      expect(
        svc.withGlobalVersionEnvelope({ type: 'x' }, { bumpVersion: false }),
      ).toEqual({ type: 'x', version: 0 });
      expect(
        svc.withGlobalVersionEnvelope('s', { bumpVersion: false }),
      ).toEqual({
        type: 'global_update',
        payload: 's',
        version: 0,
      });
      expect(service.getGlobalBroadcastVersion()).toBe(0);
    });
  });

  describe('program state lookup', () => {
    const lookupArgs = (programId: string) => ({
      where: { programId },
      select: { id: true, programId: true, type: true },
    });

    it('returns an existing record without seeding', async () => {
      const { svc, prisma } = build();
      const record = { id: 3, programId: 'p1', type: 'tv' };
      prisma.programState.findUnique.mockResolvedValue(record);
      await expect(svc.getProgramStateRecord(' p1 ')).resolves.toBe(record);
      expect(prisma.programState.findUnique).toHaveBeenCalledWith(
        lookupArgs('p1'),
      );
      expect(prisma.programState.upsert).not.toHaveBeenCalled();
    });

    it('seeds the main program when it is missing and reads it again', async () => {
      const { svc, prisma } = build();
      const record = { id: 1, programId: 'main', type: 'tv' };
      prisma.programState.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(record);
      await expect(svc.getProgramStateRecord('main')).resolves.toBe(record);
      expect(prisma.programState.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.programState.findUnique).toHaveBeenCalledTimes(2);
    });

    it('throws when main is still missing after seeding', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(svc.getProgramStateRecord('main')).rejects.toThrow(
        'Program not found',
      );
      expect(prisma.programState.findUnique).toHaveBeenCalledTimes(2);
    });

    it('throws without seeding for any other missing program', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(svc.getProgramStateRecord('ghost')).rejects.toThrow(
        'Program not found',
      );
      expect(prisma.programState.upsert).not.toHaveBeenCalled();
      expect(prisma.programState.findUnique).toHaveBeenCalledTimes(1);
    });

    it('rejects blank program ids before querying', async () => {
      const { svc, prisma } = build();
      await expect(svc.getProgramStateRecord(' ')).rejects.toThrow(
        'programId is required',
      );
      await expect(svc.getProgramStateWithScenes(' ')).rejects.toThrow(
        'programId is required',
      );
      expect(prisma.programState.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('getProgramStateWithScenes', () => {
    const scene = { id: 7, name: 'Cam' };

    it('returns the state decorated with its staged scene', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        programId: 'p1',
        stagedSceneId: 7,
        scenes: [{ sceneId: 7, scene }],
      });
      const state = await svc.getProgramStateWithScenes('p1');
      expect(state).toMatchObject({ stagedSceneId: 7, stagedScene: scene });
      const args = prisma.programState.findUnique.mock.calls[0][0];
      expect(args.where).toEqual({ programId: 'p1' });
      expect(Object.keys(args.include)).toEqual([
        'activeScene',
        'scenes',
        'mediaGroups',
        'stingers',
        'flightSequences',
      ]);
    });

    it('seeds and re-reads the main program when it is missing', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 1, programId: 'main', scenes: [] });
      const state = await svc.getProgramStateWithScenes('main');
      expect(prisma.programState.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.programState.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.programState.findUnique.mock.calls[1][0].include).toEqual(
        prisma.programState.findUnique.mock.calls[0][0].include,
      );
      expect(state).toMatchObject({
        programId: 'main',
        stagedSceneId: null,
        stagedScene: null,
      });
    });

    it('throws when main is still missing after seeding', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(svc.getProgramStateWithScenes('main')).rejects.toThrow(
        'Program not found',
      );
      expect(prisma.programState.findUnique).toHaveBeenCalledTimes(2);
    });

    it('throws without seeding for any other missing program', async () => {
      const { svc, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(svc.getProgramStateWithScenes('ghost')).rejects.toThrow(
        'Program not found',
      );
      expect(prisma.programState.upsert).not.toHaveBeenCalled();
    });
  });

  describe('withStagedSceneState', () => {
    const scene = { id: 7, name: 'Cam' };

    it('treats a missing scenes list and missing staged id as nothing staged', () => {
      const { svc } = build();
      expect(svc.withStagedSceneState({ programId: 'p' })).toEqual({
        programId: 'p',
        stagedSceneId: null,
        stagedScene: null,
      });
    });

    it('ignores a staged id that is not a number', () => {
      const { svc } = build();
      expect(
        svc.withStagedSceneState({
          stagedSceneId: '7',
          scenes: [{ sceneId: 7, scene }],
        }),
      ).toMatchObject({ stagedSceneId: null, stagedScene: null });
    });

    it('clears the staged id when no scene entry references it', () => {
      const { svc } = build();
      const result = svc.withStagedSceneState({
        programId: 'p',
        stagedSceneId: 9,
        scenes: [{ sceneId: 7, scene }],
      });
      expect(result).toEqual({
        programId: 'p',
        scenes: [{ sceneId: 7, scene }],
        stagedSceneId: null,
        stagedScene: null,
      });
    });

    it('skips malformed scene entries while matching the staged one', () => {
      const { svc } = build();
      const result = svc.withStagedSceneState({
        stagedSceneId: 7,
        scenes: [
          null,
          'x',
          [7],
          { sceneId: 8, scene: {} },
          { sceneId: 7, scene },
        ],
      });
      expect(result).toMatchObject({ stagedSceneId: 7, stagedScene: scene });
    });

    it('yields a null staged scene when the entry has no scene', () => {
      const { svc } = build();
      expect(
        svc.withStagedSceneState({
          stagedSceneId: 7,
          scenes: [{ sceneId: 7 }],
        }),
      ).toMatchObject({ stagedSceneId: 7, stagedScene: null });
      expect(
        svc.withStagedSceneState({
          stagedSceneId: 7,
          scenes: [{ sceneId: 7, scene: undefined }],
        }),
      ).toMatchObject({ stagedSceneId: 7, stagedScene: null });
    });
  });

  describe('createProgram', () => {
    const template = {
      templateUrl: 'https://example.test/tpl',
      templateManifest: { id: 'tpl' },
      templateVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never;

    it('creates a visual program with the supplied template and returns its state', async () => {
      const { service, prisma } = build();
      const created = { id: 2, programId: 'show', scenes: [] };
      prisma.programState.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created);

      const result = await service.createProgram(' show ', 'both', template);

      expect(prisma.programState.findUnique).toHaveBeenNthCalledWith(1, {
        where: { programId: 'show' },
        select: { id: true },
      });
      expect(prisma.programState.create).toHaveBeenCalledWith({
        data: {
          programId: 'show',
          type: 'both',
          templateUrl: 'https://example.test/tpl',
          templateManifest: { id: 'tpl' },
          templateVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          activeSceneId: null,
          audioMixer: expect.objectContaining({
            mainMasterVolume: 1,
            mixerChannels: DEFAULT_CHANNELS,
          }),
        },
      });
      expect(result).toMatchObject({
        programId: 'show',
        stagedSceneId: null,
        stagedScene: null,
      });
    });

    it.each([
      [undefined, 'tv'],
      ['bogus', 'tv'],
      ['tv', 'tv'],
      ['radio', 'radio'],
    ])(
      'maps requested type %s to %s and clears the template',
      async (type, stored) => {
        const { service, prisma } = build();
        prisma.programState.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 1, programId: 'x', scenes: [] });

        await service.createProgram('x', type as never);

        expect(prisma.programState.create.mock.calls[0][0].data).toMatchObject({
          type: stored,
          templateUrl: null,
          templateManifest: null,
          templateVerifiedAt: null,
        });
      },
    );

    it('refuses visual templates on radio programs before touching the database', async () => {
      const { service, prisma } = build();
      await expect(
        service.createProgram('r', 'radio', template),
      ).rejects.toThrow(
        new BadRequestException(
          'Radio programs do not support visual templates',
        ),
      );
      expect(prisma.programState.findUnique).not.toHaveBeenCalled();
    });

    it('refuses to recreate an existing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({ id: 1 });
      await expect(service.createProgram('main')).rejects.toThrow(
        'Program already exists',
      );
      expect(prisma.programState.create).not.toHaveBeenCalled();
    });
  });
});

describe('ProgramService constructor metadata with unresolved imports', () => {
  it('falls back to Object for dependency types that are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../radio/radio.service', () => ({}));
      jest.doMock('../radio/song-execution.engine', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      jest.doMock('../radio/radio-output-confidence.service', () => ({}));
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const isolated = require('./program.service') as {
          ProgramService: new (...args: never[]) => unknown;
        };
        expect(
          Reflect.getMetadata('design:paramtypes', isolated.ProgramService),
        ).toEqual([Object, Object, Object, Object, Object]);
      } finally {
        jest.dontMock('../prisma.service');
        jest.dontMock('../radio/radio.service');
        jest.dontMock('../radio/song-execution.engine');
        jest.dontMock('../observability/managed-metrics.service');
        jest.dontMock('../radio/radio-output-confidence.service');
      }
    });
  });
});
