/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Test doubles and private-state inspection are intentionally loosely typed. */
import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ProgramService } from './program.service';

type Row = Record<string, unknown>;

const manifest = {
  kind: 'alcantara.program-template',
  contractVersion: 1,
  entrypointUrl: 'https://example.test/t',
  capabilities: [],
  control: { signals: [] },
};

describe('ProgramService part 2 (program lifecycle, audio, scene instants)', () => {
  const build = () => {
    const states = new Map<string, Row>();
    const prisma = {
      programState: {
        findUnique: jest.fn(({ where }: { where: { programId: string } }) =>
          Promise.resolve(states.get(where.programId) ?? null),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      programScene: {
        findUnique: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      scene: { findUnique: jest.fn().mockResolvedValue({ id: 5 }) },
      mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
      instant: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const radio = {
      updateMixer: jest.fn().mockResolvedValue(undefined),
      getRadioSettings: jest.fn().mockResolvedValue({ enabled: true }),
      playSong: jest.fn().mockResolvedValue({ ok: true }),
    };
    const engine = {
      enqueueSong: jest.fn().mockResolvedValue([{ id: 'q1' }]),
      removeQueuedSong: jest.fn().mockResolvedValue([]),
      reorderSongQueue: jest.fn().mockResolvedValue([{ id: 'q2' }]),
      prepareContinuousRotationResume: jest.fn().mockResolvedValue(undefined),
      resumeContinuousRotation: jest.fn(),
      handleManualSong: jest.fn(),
      handleSequenceUpdated: jest.fn(),
      handleQueueUpdated: jest.fn(),
    };
    const service = new ProgramService(
      prisma as never,
      radio as never,
      engine as never,
    );
    const put = (programId: string, row: Row = {}) => {
      states.set(programId, { id: 1, programId, type: 'tv', ...row });
    };
    return { service, prisma, radio, engine, states, put };
  };

  const noVersionBroadcast = (service: ProgramService) =>
    jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined as never);

  describe('createProgram', () => {
    it('creates a tv program with template data and returns hydrated state', async () => {
      const { service, prisma, put } = build();
      prisma.programState.create.mockImplementation(
        ({ data }: { data: Row }) => {
          put(data.programId as string, { type: data.type });
          return Promise.resolve({});
        },
      );
      const result = await service.createProgram(
        ' show ',
        'weird' as never,
        {
          templateUrl: 'https://example.test/t',
          templateManifest: manifest as never,
          templateVerifiedAt: new Date('2026-01-01T00:00:00Z'),
        } as never,
      );
      const data = prisma.programState.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        programId: 'show',
        type: 'tv',
        templateUrl: 'https://example.test/t',
        activeSceneId: null,
      });
      expect(data.audioMixer.mainMasterVolume).toBe(1);
      expect(result).toMatchObject({ programId: 'show', type: 'tv' });
    });

    it('creates a radio program without a template (null template data)', async () => {
      const { service, prisma, put } = build();
      prisma.programState.create.mockImplementation(
        ({ data }: { data: Row }) => {
          put(data.programId as string, { type: data.type });
          return Promise.resolve({});
        },
      );
      await service.createProgram('fm', 'radio');
      expect(prisma.programState.create.mock.calls[0][0].data).toMatchObject({
        type: 'radio',
        templateUrl: null,
        templateManifest: null,
        templateVerifiedAt: null,
      });
    });

    it('rejects radio programs with templates and duplicates', async () => {
      const { service, put } = build();
      await expect(
        service.createProgram('fm', 'radio', {} as never),
      ).rejects.toThrow(BadRequestException);
      put('dup');
      await expect(service.createProgram('dup', 'both')).rejects.toThrow(
        'Program already exists',
      );
    });
  });

  describe('renameProgram', () => {
    it('returns current state when nothing would change', async () => {
      const { service, prisma, put } = build();
      put('a');
      const result = await service.renameProgram('a', 'a');
      expect(result).toMatchObject({ programId: 'a' });
      expect(prisma.programState.update).not.toHaveBeenCalled();
    });

    it('throws when the source is missing or the target exists', async () => {
      const { service, put } = build();
      await expect(service.renameProgram('x', 'y')).rejects.toThrow(
        'Program not found',
      );
      put('a');
      put('b');
      await expect(service.renameProgram('a', 'b')).rejects.toThrow(
        'Target program id already exists',
      );
    });

    it('rejects templates for radio by existing type and by requested type', async () => {
      const { service, put } = build();
      put('a', { type: 'radio' });
      await expect(
        service.renameProgram('a', 'a', undefined, {} as never),
      ).rejects.toThrow(BadRequestException);
      put('t', { type: 'tv', id: 2 });
      await expect(
        service.renameProgram('t', 't', 'radio', {} as never),
      ).rejects.toThrow(BadRequestException);
    });

    it.each(['radio', 'both', 'tv'])(
      'accepts requested type %s in place',
      async (type) => {
        const { service, prisma, put } = build();
        put('a', { type: 'tv' });
        await service.renameProgram('a', 'a', type);
        const data = prisma.programState.update.mock.calls[0][0].data;
        expect(data.type).toBe(type);
        expect('programId' in data).toBe(false);
        expect('scenes' in data).toBe(type === 'radio');
      },
    );

    it('ignores an unknown requested type but applies a template', async () => {
      const { service, prisma, put } = build();
      put('a', { type: 'both' });
      await service.renameProgram('a', 'a', 'nonsense', {
        templateUrl: 'u',
        templateManifest: {},
        templateVerifiedAt: null,
      } as never);
      expect(prisma.programState.update.mock.calls[0][0].data).toEqual({
        templateUrl: 'u',
        templateManifest: {},
        templateVerifiedAt: null,
      });
    });

    it('applies a null template (clearing) when explicitly passed', async () => {
      const { service, prisma, put } = build();
      put('a');
      await service.renameProgram('a', 'a', undefined, null);
      expect(prisma.programState.update.mock.calls[0][0].data).toEqual({
        templateUrl: null,
        templateManifest: null,
        templateVerifiedAt: null,
      });
    });

    it('renames and moves every in-memory map entry', async () => {
      const { service, prisma, put, states } = build();
      put('a', { id: 9 });
      put('b');
      const internals = service as any;
      const subject = { next: jest.fn() };
      internals.eventSubjects.set('a', subject);
      internals.programAudioMeterByProgramId.set('a', { m: 1 });
      internals.programSongPlaybackByProgramId.set('a', { s: 1 });
      internals.programSceneInstantPlaybackByProgramId.set('a', {
        programId: 'a',
        sceneId: 3,
      });
      states.delete('b');
      prisma.programState.update.mockImplementation(
        ({ data }: { data: Row }) => {
          states.delete('a');
          put(data.programId as string, { id: 9 });
          return Promise.resolve({});
        },
      );
      const result = await service.renameProgram('a', 'c');
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { programId: 'c' },
      });
      expect(result).toMatchObject({ programId: 'c' });
      expect(internals.eventSubjects.get('c')).toBe(subject);
      expect(internals.eventSubjects.has('a')).toBe(false);
      expect(internals.programAudioMeterByProgramId.get('c')).toEqual({ m: 1 });
      expect(internals.programSongPlaybackByProgramId.get('c')).toEqual({
        s: 1,
      });
      expect(internals.programSceneInstantPlaybackByProgramId.get('c')).toEqual(
        { programId: 'c', sceneId: 3 },
      );
      expect(internals.programSceneInstantPlaybackByProgramId.has('a')).toBe(
        false,
      );
    });

    it('renames cleanly when no in-memory state exists', async () => {
      const { service, prisma, put, states } = build();
      put('a', { id: 9, type: 'radio' });
      prisma.programState.update.mockImplementation(
        ({ data }: { data: Row }) => {
          states.delete('a');
          put(data.programId as string, { id: 9, type: 'radio' });
          return Promise.resolve({});
        },
      );
      await service.renameProgram('a', 'c');
      const data = prisma.programState.update.mock.calls[0][0].data;
      expect(data.programId).toBe('c');
      expect(data.fadeToBlack).toBe(false);
      expect((service as any).eventSubjects.size).toBe(0);
    });
  });

  describe('deleteProgram', () => {
    it('throws when missing', async () => {
      const { service } = build();
      await expect(service.deleteProgram('x')).rejects.toThrow(
        'Program not found',
      );
    });

    it('deletes and completes subjects / clears maps', async () => {
      const { service, prisma, put } = build();
      put('a', { id: 4 });
      const internals = service as any;
      const subject = { complete: jest.fn() };
      internals.eventSubjects.set('a', subject);
      internals.programAudioMeterByProgramId.set('a', {});
      internals.programSongPlaybackByProgramId.set('a', {});
      internals.programSceneInstantPlaybackByProgramId.set('a', {});
      expect(await service.deleteProgram('a')).toEqual({
        deletedProgramId: 'a',
      });
      expect(prisma.programState.delete).toHaveBeenCalledWith({
        where: { id: 4 },
      });
      expect(subject.complete).toHaveBeenCalled();
      expect(internals.eventSubjects.has('a')).toBe(false);
      expect(internals.programAudioMeterByProgramId.has('a')).toBe(false);
    });

    it('deletes without a live subject', async () => {
      const { service, put } = build();
      put('a');
      await expect(service.deleteProgram('a')).resolves.toEqual({
        deletedProgramId: 'a',
      });
    });
  });

  describe('listPrograms / getState / getPublicState / getStagedScene', () => {
    it('lists programs with staged scene state', async () => {
      const { service, prisma } = build();
      prisma.programState.findMany.mockResolvedValue([
        {
          programId: 'a',
          stagedSceneId: 2,
          scenes: [{ sceneId: 2, scene: 1 }],
        },
      ]);
      const result = await service.listPrograms();
      expect(prisma.programState.findMany.mock.calls[0][0].orderBy).toEqual({
        programId: 'asc',
      });
      expect(result[0]).toMatchObject({ stagedSceneId: 2, stagedScene: 1 });
    });

    it('returns state with topic version (default and explicit program)', async () => {
      const { service, put } = build();
      put('main');
      put('other');
      expect(await service.getState()).toMatchObject({
        programId: 'main',
        version: 0,
      });
      service.broadcastUpdate('other', { type: 'scene_change' });
      expect(await service.getState('other')).toMatchObject({ version: 1 });
    });

    it('returns the raw state without a manifest and a projection with one', async () => {
      const { service, put } = build();
      put('main', { templateManifest: null, secret: 'x' });
      expect(await service.getPublicState()).toMatchObject({ secret: 'x' });
      put('tpl', {
        templateManifest: manifest,
        secret: 'x',
        fadeToBlack: true,
      });
      const projected = (await service.getPublicState('tpl')) as Row;
      expect(projected.schemaVersion).toBe(1);
      expect(projected.fadeToBlack).toBe(true);
      expect('secret' in projected).toBe(false);
    });

    it('returns the staged scene or null placeholders (default and explicit)', async () => {
      const { service, put } = build();
      put('main', {
        stagedSceneId: 2,
        scenes: [{ sceneId: 2, scene: { id: 2 } }],
      });
      put('p2');
      expect(await service.getStagedScene()).toEqual({
        programId: 'main',
        stagedSceneId: 2,
        stagedScene: { id: 2 },
        version: 0,
      });
      expect(await service.getStagedScene('p2')).toMatchObject({
        stagedSceneId: null,
        stagedScene: null,
      });
    });

    it('falls back to null staged values when the state lacks them', async () => {
      const { service } = build();
      jest
        .spyOn(service as any, 'getProgramStateWithScenes')
        .mockResolvedValue({
          programId: 'z',
          stagedSceneId: undefined,
          stagedScene: undefined,
        });
      expect(await service.getStagedScene('z')).toMatchObject({
        stagedSceneId: null,
        stagedScene: null,
      });
    });
  });

  describe('audio bus', () => {
    const leaf = (id: string, highRotation: boolean) => ({
      id,
      kind: 'preset',
      artist: 'A',
      title: id,
      coverUrl: 'c',
      audioUrl: `u-${id}`,
      highRotation,
    });
    const sequence = (count: number) => ({
      mode: 'manual',
      items: Array.from({ length: count }, (_, i) => leaf(`s${i}`, true)),
      activeItemId: null,
      intervalMs: 1000,
      loop: false,
      startedAt: 0,
    });

    it('reads the bus (default and explicit program) and requires the program', async () => {
      const { service, put } = build();
      put('main', { songSequence: null, songQueue: [], audioMixer: {} });
      const result = await service.getProgramAudioBus();
      expect(result).toMatchObject({
        songSequence: null,
        songQueue: [],
        version: 0,
      });
      expect(result.mixerSettings.mainMasterVolume).toBe(1);
      put('x', { songSequence: { a: 1 } });
      expect((await service.getProgramAudioBus('x')).songSequence).toEqual({
        a: 1,
      });
      await expect(service.getProgramAudioBus('nope')).rejects.toThrow(
        'Program not found',
      );
    });

    it('rejects non-object payloads and missing programs', async () => {
      const { service, put } = build();
      put('main');
      for (const bad of ['str', 4, []]) {
        await expect(
          service.updateProgramAudioBus(bad as never),
        ).rejects.toThrow('audio bus payload must be an object');
      }
      await expect(
        service.updateProgramAudioBus({}, 'missing'),
      ).rejects.toThrow('Program not found');
    });

    it.each([null, undefined, {}, { other: 1 }])(
      'returns current settings untouched for payload %p',
      async (payload) => {
        const { service, prisma, put } = build();
        put('main', { songSequence: null, songQueue: [], audioMixer: null });
        const result = await service.updateProgramAudioBus(payload as never);
        expect(prisma.programState.update).not.toHaveBeenCalled();
        expect(result).toMatchObject({ songSequence: null, songQueue: [] });
        put('main', { songSequence: undefined, songQueue: [] });
        expect(
          (await service.updateProgramAudioBus(payload as never)).songSequence,
        ).toBeNull();
      },
    );

    it('rejects more than the high rotation limit', async () => {
      const { service, put } = build();
      put('main', { songQueue: [] });
      await expect(
        service.updateProgramAudioBus({ songSequence: sequence(13) }),
      ).rejects.toThrow('High rotation is limited to 12 songs');
    });

    it('updates the sequence, filters the queue, notifies the engine', async () => {
      const { service, prisma, engine, radio, put } = build();
      put('main', {
        songSequence: null,
        songQueue: [],
        audioMixer: {},
        type: 'tv',
      });
      prisma.programState.update.mockResolvedValue({
        songSequence: sequence(1),
        songQueue: [],
        audioMixer: {},
      });
      const seq = sequence(1);
      const result = await service.updateProgramAudioBus({
        songSequence: seq,
      });
      const args = prisma.programState.update.mock.calls[0][0];
      expect(args.where).toEqual({ programId: 'main' });
      expect('songQueue' in args.data).toBe(true);
      expect(engine.handleSequenceUpdated).toHaveBeenCalledWith('main', seq);
      expect(engine.handleQueueUpdated).toHaveBeenCalledWith('main', []);
      expect(radio.updateMixer).not.toHaveBeenCalled();
      expect(result.version).toBe(1);
    });

    it('treats an explicitly undefined songSequence as null', async () => {
      const { service, prisma, engine, put } = build();
      put('main', { songSequence: { x: 1 }, songQueue: [] });
      prisma.programState.update.mockResolvedValue({
        songSequence: null,
        songQueue: [],
        audioMixer: null,
      });
      await service.updateProgramAudioBus({ songSequence: undefined });
      expect(
        prisma.programState.update.mock.calls[0][0].data.songSequence,
      ).toBe(null);
      expect(engine.handleSequenceUpdated).toHaveBeenCalledWith('main', null);
    });

    it.each([
      ['radio', true],
      ['both', true],
      ['tv', false],
    ])(
      'mixer-only update on %s program forwards to radio: %p',
      async (type, forwards) => {
        const { service, prisma, engine, radio, put } = build();
        put('main', {
          type,
          songSequence: sequence(1),
          songQueue: [],
          audioMixer: null,
        });
        prisma.programState.update.mockImplementation(
          ({ data }: { data: Row }) =>
            Promise.resolve({
              songSequence: null,
              songQueue: [],
              audioMixer: data.audioMixer,
            }),
        );
        const result = await service.updateProgramAudioBus({
          mixerSettings: { songMasterVolume: 0.5 },
        });
        const args = prisma.programState.update.mock.calls[0][0];
        expect('songQueue' in args.data).toBe(false);
        expect(args.data.songSequence).toEqual(sequence(1));
        expect(engine.handleSequenceUpdated).not.toHaveBeenCalled();
        expect(result.mixerSettings.songMasterVolume).toBe(0.5);
        expect(radio.updateMixer).toHaveBeenCalledTimes(forwards ? 1 : 0);
        if (forwards) {
          expect(radio.updateMixer.mock.calls[0][0]).toBe('main');
        }
      },
    );

    it('uses the topic version when the broadcast carries none', async () => {
      const { service, prisma, put } = build();
      put('main', { songQueue: [] });
      prisma.programState.update.mockResolvedValue({});
      noVersionBroadcast(service);
      const result = await service.updateProgramAudioBus({
        mixerSettings: {},
      });
      expect(result.version).toBe(0);
    });
  });

  describe('song queue / rotation passthroughs', () => {
    it('delegates to the engine with normalized program ids', async () => {
      const { service, engine } = build();
      expect(await service.enqueueProgramSong(' p ', 'i')).toEqual({
        songQueue: [{ id: 'q1' }],
        version: 0,
      });
      expect(engine.enqueueSong).toHaveBeenCalledWith('p', 'i');
      expect(await service.removeQueuedProgramSong('p', 'e')).toEqual({
        songQueue: [],
        version: 0,
      });
      expect(engine.removeQueuedSong).toHaveBeenCalledWith('p', 'e');
      expect(await service.reorderProgramSongQueue('p', ['a'])).toEqual({
        songQueue: [{ id: 'q2' }],
        version: 0,
      });
      expect(engine.reorderSongQueue).toHaveBeenCalledWith('p', ['a']);
      await service.prepareContinuousRotationResume(' p ');
      expect(engine.prepareContinuousRotationResume).toHaveBeenCalledWith('p');
      service.resumeContinuousRotation(' p ');
      expect(engine.resumeContinuousRotation).toHaveBeenCalledWith('p');
    });

    it('takes catalog songs on air with and without optional fields', () => {
      const { service, engine } = build();
      service.takeCatalogSongOnAir(
        ' p ',
        {
          id: 3,
          audioUrl: 'u',
          title: 't',
          artist: 'a',
          coverUrl: 'c',
          durationMs: 99,
        },
        { instantId: 1 },
      );
      expect(engine.handleManualSong).toHaveBeenLastCalledWith(
        'p',
        'u',
        't',
        'a',
        99,
        'c',
        3,
        { instantId: 1 },
      );
      service.takeCatalogSongOnAir('p', {
        id: 4,
        audioUrl: 'u2',
        title: 't2',
        artist: 'a2',
        coverUrl: null,
        durationMs: null,
      });
      expect(engine.handleManualSong).toHaveBeenLastCalledWith(
        'p',
        'u2',
        't2',
        'a2',
        undefined,
        undefined,
        4,
        undefined,
      );
    });
  });

  describe('audio meter', () => {
    it('returns zeros then the stored meter (default program)', async () => {
      const { service, put } = build();
      put('main');
      const empty = await service.getProgramAudioMeter();
      expect(empty.main).toEqual({ vu: 0, peak: 0, peakHold: 0 });
      expect(empty.updatedAt).toBe(new Date(0).toISOString());
      await service.updateProgramAudioMeter({
        song: 0.5,
        instants: 0,
        main: 1,
      });
      const stored = await service.getProgramAudioMeter('main');
      expect(stored.song).toEqual({ vu: 0.5, peak: 0.5, peakHold: 0.5 });
      expect(stored.version).toBe(1);
    });

    it('normalizes number and object channels, clamping and defaulting', async () => {
      const { service, put } = build();
      put('main');
      put('m2');
      const result = await service.updateProgramAudioMeter({
        song: 5,
        instants: { level: 0.4 },
        sceneInstant: { vu: 0.2, peak: 0.1, peakHold: 0.05 },
        main: { vu: 0.3, peak: 0.6 },
      });
      expect(result.song).toEqual({ vu: 1, peak: 1, peakHold: 1 });
      expect(result.instants).toEqual({ vu: 0.4, peak: 0.4, peakHold: 0.4 });
      expect(result.sceneInstant).toEqual({
        vu: 0.2,
        peak: 0.2,
        peakHold: 0.2,
      });
      expect(result.main).toEqual({ vu: 0.3, peak: 0.6, peakHold: 0.6 });
      const defaultScene = await service.updateProgramAudioMeter(
        { song: -3, instants: 0, main: 0 },
        'm2',
      );
      expect(defaultScene.sceneInstant).toEqual({
        vu: 0,
        peak: 0,
        peakHold: 0,
      });
      expect(defaultScene.song.vu).toBe(0);
    });

    it('rejects invalid payloads and channels', async () => {
      const { service, put } = build();
      put('main');
      for (const bad of [null, undefined, 'x']) {
        await expect(
          service.updateProgramAudioMeter(bad as never),
        ).rejects.toThrow('audio meter payload must be an object');
      }
      for (const badChannel of [null, undefined, 'x', [], NaN, Infinity]) {
        await expect(
          service.updateProgramAudioMeter({
            song: badChannel,
            instants: 0,
            main: 0,
          }),
        ).rejects.toThrow(
          'song must be a number or an object with vu/peak/peakHold',
        );
      }
      await expect(
        service.updateProgramAudioMeter({
          song: { vu: 'loud' },
          instants: 0,
          main: 0,
        }),
      ).rejects.toThrow('song.vu must be a finite number');
      await expect(
        service.updateProgramAudioMeter({
          song: { vu: 1, peak: NaN },
          instants: 0,
          main: 0,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateProgramAudioMeter({
          song: { vu: 1, peak: 1, peakHold: 'x' },
          instants: 0,
          main: 0,
        }),
      ).rejects.toThrow('song.peakHold must be a finite number');
    });

    it('uses the topic version when the broadcast has none', async () => {
      const { service, put } = build();
      put('main');
      noVersionBroadcast(service);
      const result = await service.updateProgramAudioMeter({
        song: 0,
        instants: 0,
        main: 0,
      });
      expect(result.version).toBe(0);
    });
  });

  describe('song playback', () => {
    const base = {
      token: 't1',
      audioUrl: 'http://a/1.mp3',
      progress: 0.1,
      currentTimeMs: 5000,
      durationMs: 60000,
      isPlaying: true,
    };

    it('returns the empty playback then the stored one (default program)', async () => {
      const { service, put } = build();
      put('main');
      const empty = await service.getProgramSongPlayback();
      expect(empty).toMatchObject({
        token: '',
        isPlaying: false,
        durationMs: null,
        version: 0,
      });
      await service.updateProgramSongPlayback(base);
      expect(await service.getProgramSongPlayback('main')).toMatchObject({
        token: 't1',
        version: 1,
      });
    });

    it('validates every field', async () => {
      const { service, put } = build();
      put('main');
      for (const bad of [null, undefined, 'x']) {
        await expect(
          service.updateProgramSongPlayback(bad as never),
        ).rejects.toThrow('song playback payload must be an object');
      }
      const cases: Array<[Partial<Record<string, unknown>>, string]> = [
        [{ progress: 'x' }, 'progress must be a finite number'],
        [{ progress: NaN }, 'progress must be a finite number'],
        [{ currentTimeMs: 'x' }, 'currentTimeMs must be a finite number'],
        [{ durationMs: 0 }, 'durationMs must be a positive number or null'],
        [{ durationMs: 'x' }, 'durationMs must be a positive number or null'],
        [{ durationMs: NaN }, 'durationMs must be a positive number or null'],
        [{ isPlaying: 'yes' }, 'isPlaying must be a boolean'],
      ];
      for (const [patch, message] of cases) {
        await expect(
          service.updateProgramSongPlayback({ ...base, ...patch } as never),
        ).rejects.toThrow(message);
      }
    });

    it('normalizes tokens, urls, null/undefined duration and clamps time', async () => {
      const { service, put, radio } = build();
      put('main');
      const r1 = await service.updateProgramSongPlayback({
        token: 5 as never,
        audioUrl: 7 as never,
        progress: 2,
        currentTimeMs: -4.4,
        durationMs: null,
        isPlaying: false,
      });
      expect(r1).toMatchObject({
        token: '',
        audioUrl: '',
        progress: 1,
        currentTimeMs: 0,
        durationMs: null,
      });
      const r2 = await service.updateProgramSongPlayback({
        token: '  tok ',
        audioUrl: ' http://a/b.mp3 ',
        progress: 0.5,
        currentTimeMs: 99999,
        durationMs: 1000.4,
        isPlaying: false,
      });
      expect(r2).toMatchObject({
        token: 'tok',
        audioUrl: 'http://a/b.mp3',
        currentTimeMs: 1000,
        durationMs: 1000,
      });
      const r3 = await service.updateProgramSongPlayback({
        token: 'x',
        audioUrl: '',
        progress: 0,
        currentTimeMs: 0,
        isPlaying: true,
      });
      expect(r3.durationMs).toBeNull();
      expect(radio.playSong).not.toHaveBeenCalled();
    });

    it('forwards new songs to a radio-capable program only when the track changes', async () => {
      const { service, put, radio } = build();
      put('main');
      await service.updateProgramSongPlayback(base);
      expect(radio.playSong).toHaveBeenCalledTimes(1);
      expect(radio.playSong).toHaveBeenCalledWith('main', base.audioUrl);
      // Same track, same url: no forward.
      await service.updateProgramSongPlayback({
        ...base,
        currentTimeMs: 5200,
      });
      expect(radio.playSong).toHaveBeenCalledTimes(1);
      // Token changed.
      await service.updateProgramSongPlayback({ ...base, token: 't2' });
      expect(radio.playSong).toHaveBeenCalledTimes(2);
      // Url changed.
      await service.updateProgramSongPlayback({
        ...base,
        token: 't2',
        audioUrl: 'http://a/2.mp3',
      });
      expect(radio.playSong).toHaveBeenCalledTimes(3);
      // Not playing: never forward.
      await service.updateProgramSongPlayback({
        ...base,
        token: 't3',
        isPlaying: false,
      });
      expect(radio.playSong).toHaveBeenCalledTimes(3);
    });

    it('surfaces a rejected radio command as a bad gateway', async () => {
      const { service, put, radio } = build();
      put('main');
      radio.playSong.mockResolvedValue({ ok: false });
      await expect(service.updateProgramSongPlayback(base)).rejects.toThrow(
        BadGatewayException,
      );
    });

    it('ignores backward drift beyond the threshold for the same playing track', async () => {
      const { service, put } = build();
      put('main');
      const first = await service.updateProgramSongPlayback(base);
      const drift = await service.updateProgramSongPlayback({
        ...base,
        currentTimeMs: 4000,
      });
      expect(drift.currentTimeMs).toBe(5000);
      expect(drift.updatedAt).toBe(first.updatedAt);
      // Small backward drift is accepted.
      const small = await service.updateProgramSongPlayback({
        ...base,
        currentTimeMs: 4800,
      });
      expect(small.currentTimeMs).toBe(4800);
    });

    it.each([
      ['previous token empty', { token: '' }, base],
      ['new token empty', base, { ...base, token: '' }],
      ['token differs', base, { ...base, token: 'other', currentTimeMs: 1 }],
      [
        'url differs',
        base,
        { ...base, audioUrl: 'http://a/z.mp3', currentTimeMs: 1 },
      ],
      [
        'previous not playing',
        { isPlaying: false },
        { ...base, currentTimeMs: 1 },
      ],
    ])('accepts a backward jump when %s', async (_name, first, second) => {
      const { service, put } = build();
      put('main');
      await service.updateProgramSongPlayback({ ...base, ...first });
      const result = await service.updateProgramSongPlayback(second);
      expect(result.currentTimeMs).toBe(second.currentTimeMs);
    });

    it('uses the topic version when the broadcast has none', async () => {
      const { service, put } = build();
      put('main');
      noVersionBroadcast(service);
      expect((await service.updateProgramSongPlayback(base)).version).toBe(0);
    });
  });

  describe('scene instant playback', () => {
    const scene = (metadata: unknown, id = 5) => ({
      sceneId: id,
      scene: { id, metadata },
    });

    it('reads the empty then stored playback (default program)', async () => {
      const { service, put } = build();
      put('main', { activeSceneId: 5, scenes: [scene({})] });
      expect(await service.getProgramSceneInstantPlayback()).toMatchObject({
        programId: 'main',
        isPlaying: false,
        instant: null,
        version: 0,
      });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        programId: 'main',
        isPlaying: true,
      });
      expect(
        await service.getProgramSceneInstantPlayback('main'),
      ).toMatchObject({ isPlaying: true });
    });

    describe('parseSceneBackgroundFromSceneMetadata', () => {
      const parse = (value: unknown) =>
        (build().service as any).parseSceneBackgroundFromSceneMetadata(value);

      it.each([
        [null],
        [undefined],
        [''],
        ['   '],
        ['not json'],
        ['null'],
        ['[1]'],
        [[1]],
        [5],
        [0],
        [{}],
        [{ sceneInstant: null }],
        [{ sceneInstant: 'x' }],
        [{ sceneInstant: [1] }],
        [{ sceneInstant: {} }],
        [{ sceneInstant: { assetId: '  ', instantId: -1 } }],
        [{ sceneInstant: { assetId: 5, instantId: 1.5 } }],
        [{ sceneInstant: { instantId: 'abc' } }],
      ])('returns null for %p', (value) => {
        expect(parse(value)).toBeNull();
      });

      it('extracts asset and instant ids from objects and JSON strings', () => {
        expect(
          parse({ sceneInstant: { assetId: ' a1 ', instantId: 4 } }),
        ).toEqual({ assetId: 'a1', instantId: 4 });
        expect(
          parse(JSON.stringify({ sceneInstant: { instantId: '7' } })),
        ).toEqual({ assetId: null, instantId: 7 });
        expect(parse({ sceneInstant: { assetId: 'only' } })).toEqual({
          assetId: 'only',
          instantId: null,
        });
      });
    });

    describe('takeProgramSceneInstant', () => {
      const setup = (metadata: unknown = null, extra: Row = {}) => {
        const ctx = build();
        ctx.put('main', {
          activeSceneId: 5,
          scenes: [scene(metadata)],
          ...extra,
        });
        return ctx;
      };

      it('requires program, target and assignment', async () => {
        const { service, put } = build();
        await expect(service.takeProgramSceneInstant(1)).rejects.toThrow(
          'Program not found',
        );
        put('main', { activeSceneId: null, scenes: [scene(null)] });
        await expect(
          service.takeProgramSceneInstant(undefined),
        ).rejects.toThrow('No target scene selected');
        await expect(service.takeProgramSceneInstant(NaN)).rejects.toThrow(
          'No target scene selected',
        );
        put('main', { activeSceneId: undefined, scenes: [] });
        await expect(service.takeProgramSceneInstant(null)).rejects.toThrow(
          BadRequestException,
        );
        await expect(service.takeProgramSceneInstant(9)).rejects.toThrow(
          'Scene is not assigned to this program',
        );
      });

      it('requires a configured background', async () => {
        const { service } = setup(null);
        await expect(service.takeProgramSceneInstant(5)).rejects.toThrow(
          'Scene has no configured background audio',
        );
        await expect(
          service.takeProgramSceneInstant(5, 'main', -3, '  '),
        ).rejects.toThrow('Scene has no configured background audio');
        await expect(
          service.takeProgramSceneInstant(5, 'main', 1.5, 12 as never),
        ).rejects.toThrow('Scene has no configured background audio');
        await expect(
          service.takeProgramSceneInstant(5, 'main', NaN, undefined),
        ).rejects.toThrow('Scene has no configured background audio');
      });

      it('plays a configured media asset (audio clip present)', async () => {
        const { service, prisma } = setup({
          sceneInstant: { assetId: 'asset-1' },
        });
        prisma.mediaAsset.findFirst.mockResolvedValue({
          id: 'asset-1',
          name: 'Rain',
          sourceUrl: 'http://x/rain.mp3',
          backgroundAudio: { defaultVolume: 0.3 },
          audioClip: { id: 77 },
        });
        const events: Row[] = [];
        service.addEventListener((e) => events.push(e.data));
        const result = await service.takeProgramSceneInstant(5.4);
        expect(result).toMatchObject({
          programId: 'main',
          sceneId: 5,
          instantId: 77,
          mediaAssetId: 'asset-1',
          isPlaying: true,
          instant: {
            id: 77,
            assetId: 'asset-1',
            name: 'Rain',
            audioUrl: 'http://x/rain.mp3',
            volume: 0.3,
          },
          version: 1,
        });
        expect(events[0]).toMatchObject({
          type: 'scene_instant_take',
          sceneId: 5,
          loop: true,
        });
        expect(prisma.mediaAsset.findFirst.mock.calls[0][0].where).toEqual({
          id: 'asset-1',
          enabled: true,
          backgroundAudio: { isNot: null },
        });
      });

      it('plays an overriding media asset without an audio clip', async () => {
        const { service, prisma } = setup({
          sceneInstant: { instantId: 3 },
        });
        prisma.mediaAsset.findFirst.mockResolvedValue({
          id: 'o',
          name: 'N',
          sourceUrl: 'u',
          backgroundAudio: { defaultVolume: 1 },
          audioClip: null,
        });
        const result = await service.takeProgramSceneInstant(
          5,
          'main',
          9,
          ' o ',
        );
        expect(result.instantId).toBeNull();
        expect(prisma.mediaAsset.findFirst.mock.calls[0][0].where.id).toBe('o');
        expect(prisma.instant.findUnique).not.toHaveBeenCalled();
      });

      it('ignores configured instant when only an asset override is given', async () => {
        const { service, prisma } = setup({ sceneInstant: { instantId: 3 } });
        prisma.mediaAsset.findFirst.mockResolvedValue({
          id: 'o',
          name: 'N',
          sourceUrl: 'u',
          backgroundAudio: { defaultVolume: 1 },
          audioClip: { id: 2 },
        });
        const result = await service.takeProgramSceneInstant(
          5,
          'main',
          null,
          'o',
        );
        expect(result.instantId).toBe(2);
        expect(prisma.instant.findUnique).not.toHaveBeenCalled();
      });

      it('fails when the asset is missing or lacks background audio', async () => {
        const { service, prisma } = setup({ sceneInstant: { assetId: 'a' } });
        await expect(service.takeProgramSceneInstant(5)).rejects.toThrow(
          NotFoundException,
        );
        prisma.mediaAsset.findFirst.mockResolvedValue({
          id: 'a',
          backgroundAudio: null,
        });
        await expect(service.takeProgramSceneInstant(5)).rejects.toThrow(
          'Configured background audio asset not found',
        );
      });

      it('plays a configured instant, an override instant, and rejects bad ones', async () => {
        const { service, prisma } = setup({ sceneInstant: { instantId: 3 } });
        await expect(service.takeProgramSceneInstant(5)).rejects.toThrow(
          'Configured scene instant not found',
        );
        prisma.instant.findUnique.mockResolvedValue({
          id: 3,
          enabled: false,
        });
        await expect(service.takeProgramSceneInstant(5)).rejects.toThrow(
          'Configured scene instant is disabled',
        );
        prisma.instant.findUnique.mockResolvedValue({
          id: 8,
          enabled: true,
          assetId: 'as',
          name: 'Bell',
          audioUrl: 'http://x/bell.mp3',
          volume: 0.9,
        });
        const configured = await service.takeProgramSceneInstant(5);
        expect(prisma.instant.findUnique).toHaveBeenLastCalledWith({
          where: { id: 3 },
        });
        expect(configured).toMatchObject({
          instantId: 8,
          mediaAssetId: 'as',
          instant: { name: 'Bell', volume: 0.9 },
        });
        await service.takeProgramSceneInstant(5, 'main', 12);
        expect(prisma.instant.findUnique).toHaveBeenLastCalledWith({
          where: { id: 12 },
        });
        expect(
          (service as any).programSceneInstantPlaybackByProgramId.get('main')
            .isPlaying,
        ).toBe(true);
      });

      it('uses the topic version when the broadcast has none', async () => {
        const { service, prisma } = setup({ sceneInstant: { instantId: 3 } });
        prisma.instant.findUnique.mockResolvedValue({
          id: 3,
          enabled: true,
          assetId: null,
          name: 'n',
          audioUrl: 'u',
          volume: 1,
        });
        noVersionBroadcast(service);
        expect((await service.takeProgramSceneInstant(5)).version).toBe(0);
      });
    });

    describe('stopProgramSceneInstant', () => {
      it('stops an empty playback with default fade', async () => {
        const { service, put } = build();
        put('main');
        const events: Row[] = [];
        service.addEventListener((e) => events.push(e.data));
        const result = await service.stopProgramSceneInstant();
        expect(result).toMatchObject({
          isPlaying: false,
          startedAt: null,
          version: 1,
        });
        expect(events[0]).toMatchObject({
          type: 'scene_instant_stop',
          sceneId: null,
          instantId: null,
          mediaAssetId: null,
          fadeMs: 0,
        });
      });

      it('stops an active playback with an explicit fade', async () => {
        const { service, put } = build();
        put('p');
        (service as any).programSceneInstantPlaybackByProgramId.set('p', {
          programId: 'p',
          sceneId: 5,
          instantId: 2,
          mediaAssetId: 'm',
          isPlaying: true,
          instant: null,
          startedAt: 'x',
          updatedAt: 'y',
        });
        const events: Row[] = [];
        service.addEventListener((e) => events.push(e.data));
        await service.stopProgramSceneInstant('p', 250);
        expect(events[0]).toMatchObject({
          sceneId: 5,
          instantId: 2,
          mediaAssetId: 'm',
          fadeMs: 250,
        });
      });

      it('handles previous playback with undefined ids and a missing version', async () => {
        const { service, put } = build();
        put('p');
        (service as any).programSceneInstantPlaybackByProgramId.set('p', {
          programId: 'p',
          isPlaying: true,
        });
        const spy = noVersionBroadcast(service);
        const result = await service.stopProgramSceneInstant('p');
        expect(spy.mock.calls[0][1]).toMatchObject({
          sceneId: null,
          instantId: null,
          mediaAssetId: null,
        });
        expect(result.version).toBe(0);
      });
    });
  });

  describe('proxyAudio', () => {
    const response = (init: Partial<Record<string, unknown>> = {}) =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array([1, 2]).buffer),
        headers: { get: jest.fn().mockReturnValue('audio/mpeg') },
        ...init,
      }) as never;

    afterEach(() => jest.restoreAllMocks());

    it('validates the url', async () => {
      const { service } = build();
      for (const bad of [undefined, 5, '', '   ']) {
        await expect(service.proxyAudio(bad)).rejects.toThrow(
          'url is required',
        );
      }
      await expect(service.proxyAudio('nope')).rejects.toThrow(
        'url must be an absolute URL',
      );
      await expect(service.proxyAudio('ftp://x/y')).rejects.toThrow(
        'url must use http or https',
      );
    });

    it('maps fetch failures and upstream errors to bad gateway', async () => {
      const { service } = build();
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('down'));
      await expect(service.proxyAudio('http://x/a.mp3')).rejects.toThrow(
        'failed to fetch remote audio',
      );
      fetchSpy.mockResolvedValueOnce(response({ ok: false, status: 503 }));
      await expect(service.proxyAudio('http://x/a.mp3')).rejects.toThrow(
        'remote audio returned HTTP 503',
      );
    });

    it('rejects oversized audio', async () => {
      const { service } = build();
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        response({
          arrayBuffer: jest
            .fn()
            .mockResolvedValue({ byteLength: 100 * 1024 * 1024 + 1 }),
        }),
      );
      await expect(service.proxyAudio('https://x/a.mp3')).rejects.toThrow(
        'audio file is too large to proxy',
      );
    });

    it('returns the buffer with the upstream or default content type', async () => {
      const { service } = build();
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(response());
      const ok = await service.proxyAudio(' http://x/a.mp3 ');
      expect(fetchSpy).toHaveBeenCalledWith('http://x/a.mp3');
      expect(ok.buffer).toEqual(Buffer.from([1, 2]));
      expect(ok.contentType).toBe('audio/mpeg');
      fetchSpy.mockResolvedValueOnce(
        response({ headers: { get: jest.fn().mockReturnValue(null) } }),
      );
      expect((await service.proxyAudio('http://x/b')).contentType).toBe(
        'application/octet-stream',
      );
    });
  });

  describe('program scenes', () => {
    it('rejects radio programs, unknown scenes', async () => {
      const { service, put, prisma } = build();
      put('main', { type: 'radio' });
      await expect(service.addSceneToProgram(5)).rejects.toThrow(
        'Radio programs do not support scenes',
      );
      put('main', { type: 'tv' });
      prisma.scene.findUnique.mockResolvedValue(null);
      await expect(service.addSceneToProgram(5)).rejects.toThrow(
        'Scene not found',
      );
    });

    it('appends a new scene after the max position (default program)', async () => {
      const { service, put, prisma } = build();
      put('main');
      prisma.programScene.aggregate.mockResolvedValue({
        _max: { position: 3 },
      });
      const events: Row[] = [];
      service.addEventListener((e) => events.push(e.data));
      const result = await service.addSceneToProgram(5);
      expect(prisma.programScene.create).toHaveBeenCalledWith({
        data: { programStateId: 1, sceneId: 5, position: 4 },
      });
      expect(events[0]).toMatchObject({
        type: 'program_scenes_changed',
        programId: 'main',
      });
      expect(result.version).toBe(1);
    });

    it('starts at position 0, skips existing assignments, and falls back on version', async () => {
      const { service, put, prisma } = build();
      put('p');
      await service.addSceneToProgram(5, 'p');
      expect(prisma.programScene.create).toHaveBeenCalledWith({
        data: { programStateId: 1, sceneId: 5, position: 0 },
      });
      prisma.programScene.create.mockClear();
      prisma.programScene.findUnique.mockResolvedValue({ id: 1 });
      noVersionBroadcast(service);
      const result = await service.addSceneToProgram(5, 'p');
      expect(prisma.programScene.create).not.toHaveBeenCalled();
      // Falls back to the topic version bumped by the first broadcast.
      expect(result.version).toBe(1);
    });

    it('removes scenes and clears matching active / staged ids', async () => {
      const { service, put, prisma } = build();
      put('main', { activeSceneId: 5, stagedSceneId: 6 });
      await service.removeSceneFromProgram(5);
      expect(prisma.programScene.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 1, sceneId: 5 },
      });
      expect(prisma.programState.update).toHaveBeenLastCalledWith({
        where: { id: 1 },
        data: { activeSceneId: null },
      });
      put('main', { activeSceneId: 4, stagedSceneId: 5 });
      await service.removeSceneFromProgram(5, 'main');
      expect(prisma.programState.update).toHaveBeenLastCalledWith({
        where: { id: 1 },
        data: { stagedSceneId: null },
      });
      put('main', { activeSceneId: 5, stagedSceneId: 5 });
      await service.removeSceneFromProgram(5, 'main');
      expect(prisma.programState.update).toHaveBeenLastCalledWith({
        where: { id: 1 },
        data: { activeSceneId: null, stagedSceneId: null },
      });
    });

    it('leaves the program row alone when neither bus points at the scene', async () => {
      const { service, put, prisma } = build();
      put('main', { activeSceneId: 1, stagedSceneId: 2 });
      noVersionBroadcast(service);
      const result = await service.removeSceneFromProgram(5);
      expect(prisma.programState.update).not.toHaveBeenCalled();
      expect(result.version).toBe(0);
    });

    it('throws for a missing program', async () => {
      const { service } = build();
      await expect(service.removeSceneFromProgram(5, 'zzz')).rejects.toThrow(
        'Program not found',
      );
    });

    it('stops scene-instant playback only for the playing removed scene', async () => {
      const { service, put } = build();
      put('main', { activeSceneId: 1 });
      const internals = service as any;
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      internals.programSceneInstantPlaybackByProgramId.set('main', {
        programId: 'main',
        sceneId: 9,
        isPlaying: true,
      });
      await service.removeSceneFromProgram(5);
      expect(stop).not.toHaveBeenCalled();
      internals.programSceneInstantPlaybackByProgramId.set('main', {
        programId: 'main',
        sceneId: 5,
        isPlaying: false,
      });
      await service.removeSceneFromProgram(5);
      expect(stop).not.toHaveBeenCalled();
      internals.programSceneInstantPlaybackByProgramId.set('main', {
        programId: 'main',
        sceneId: 5,
        isPlaying: true,
      });
      await service.removeSceneFromProgram(5);
      expect(stop).toHaveBeenCalledWith('main');
      expect(
        internals.programSceneInstantPlaybackByProgramId.get('main').isPlaying,
      ).toBe(false);
    });
  });
});
