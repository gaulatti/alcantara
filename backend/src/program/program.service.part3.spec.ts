/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { MediaAssetKind } from '@prisma/client';
import { ProgramService } from './program.service';
import {
  deleteMediaAsset,
  syncAudioClipAsset,
} from '../media-assets/media-asset-sync';

jest.mock('../media-assets/media-asset-sync', () => ({
  deleteMediaAsset: jest.fn().mockResolvedValue(undefined),
  syncAudioClipAsset: jest.fn().mockResolvedValue(undefined),
}));

const templateManifest = {
  kind: 'alcantara.program-template',
  contractVersion: 1,
  entrypointUrl: 'https://cdn.fifthbell.com/t/index.js',
  capabilities: [],
  control: { signals: ['heartbeat', 'scene_change'] },
};
const templateManifestNoHeartbeat = {
  ...templateManifest,
  control: { signals: ['scene_change'] },
};

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    programId: 'main',
    type: 'tv',
    activeSceneId: null,
    stagedSceneId: null,
    fadeToBlack: false,
    activeScene: null,
    scenes: [],
    mediaGroups: [],
    stingers: [],
    flightSequences: [],
    songSequence: null,
    audioMixer: null,
    ...overrides,
  } as any;
}

function build(opts: { metrics?: boolean; state?: any } = {}) {
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue(opts.state ?? makeState()),
      findMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    programScene: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    mediaGroup: { findUnique: jest.fn() },
    programMediaGroup: {
      findUnique: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    stinger: { findUnique: jest.fn() },
    programStinger: {
      findUnique: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    instant: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
  const radio: any = {
    getRadioSettings: jest.fn().mockResolvedValue({ enabled: true }),
    playInstant: jest.fn().mockResolvedValue(undefined),
    stopAllInstants: jest.fn().mockResolvedValue(undefined),
    playSong: jest.fn().mockResolvedValue({ ok: true }),
    stopSong: jest.fn().mockResolvedValue(undefined),
  };
  const engine: any = {
    handleSequenceUpdated: jest.fn(),
    handleStopSong: jest.fn(),
    setBroadcastHandler: jest.fn(),
  };
  const metrics: any = {
    recordSceneHandoff: jest.fn(),
    recordProgramSseConnection: jest.fn(),
    recordProgramSseSnapshot: jest.fn(),
  };
  const confidence: any = { observe: jest.fn() };
  const service = new ProgramService(
    prisma,
    radio,
    engine,
    opts.metrics === false ? undefined : metrics,
    confidence,
  );
  return { service, prisma, radio, engine, metrics, confidence };
}

describe('ProgramService part 3 (scene/media/stinger/instant/stream)', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('removeSceneFromProgram', () => {
    it('throws when the program does not exist', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.removeSceneFromProgram(3, 'x')).rejects.toThrow(
        'Program not found',
      );
    });

    it('clears active and staged scene and stops a playing scene instant', async () => {
      const { service, prisma } = build({
        state: makeState({ activeSceneId: 3, stagedSceneId: 3 }),
      });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        isPlaying: true,
        sceneId: 3,
      });
      const stop = jest
        .spyOn(service, 'stopProgramSceneInstant')
        .mockResolvedValue({} as any);
      const result = await service.removeSceneFromProgram(3);
      expect(prisma.programScene.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 1, sceneId: 3 },
      });
      expect(stop).toHaveBeenCalledWith('main');
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { activeSceneId: null, stagedSceneId: null },
      });
      expect(result.version).toBe(1);
    });

    it('only clears the staged scene and keeps non-matching playback running', async () => {
      const { service, prisma } = build({
        state: makeState({ activeSceneId: 9, stagedSceneId: 3 }),
      });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        isPlaying: true,
        sceneId: 99,
      });
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      (service as any).topicVersionByProgramId.state.set('main', 7);
      const result = await service.removeSceneFromProgram(3, 'main');
      expect(stop).not.toHaveBeenCalled();
      expect(prisma.programScene.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 1, sceneId: 3 },
      });
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { stagedSceneId: null },
      });
      expect(result.version).toBe(7);
    });

    it('does not update state when the removed scene is neither active nor staged', async () => {
      const { service, prisma } = build({
        state: makeState({ activeSceneId: 9, stagedSceneId: 8 }),
      });
      jest
        .spyOn(service, 'broadcastUpdate')
        .mockReturnValue({ version: undefined });
      await service.removeSceneFromProgram(3);
      expect(prisma.programState.update).not.toHaveBeenCalled();
    });

    it('clears only the active scene when it is the removed one', async () => {
      const { service, prisma } = build({
        state: makeState({ activeSceneId: 3, stagedSceneId: 8 }),
      });
      await service.removeSceneFromProgram(3);
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { activeSceneId: null },
      });
    });
  });

  describe('media groups', () => {
    it('lists program media groups mapped to their public shape', async () => {
      const d = new Date('2026-01-01T00:00:00Z');
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        mediaGroups: [
          {
            mediaGroup: {
              id: 1,
              name: 'G',
              description: 'd',
              createdAt: d,
              updatedAt: d,
              mediaItems: [
                {
                  id: 5,
                  mediaGroupId: 1,
                  mediaId: 9,
                  position: 0,
                  media: {
                    id: 9,
                    name: 'm',
                    imageUrl: 'u',
                    createdAt: d,
                    updatedAt: d,
                    extra: 'hidden',
                  },
                },
              ],
            },
          },
        ],
      });
      expect(await service.listProgramMediaGroups()).toEqual([
        {
          id: 1,
          name: 'G',
          description: 'd',
          createdAt: d,
          updatedAt: d,
          items: [
            {
              id: 5,
              mediaGroupId: 1,
              mediaId: 9,
              position: 0,
              media: {
                id: 9,
                name: 'm',
                imageUrl: 'u',
                createdAt: d,
                updatedAt: d,
              },
            },
          ],
        },
      ]);
    });

    it('throws when listing media groups of a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.listProgramMediaGroups('zz')).rejects.toThrow(
        'Program not found',
      );
    });

    it('rejects adding media groups to radio programs', async () => {
      const { service } = build({ state: makeState({ type: 'radio' }) });
      await expect(service.addMediaGroupToProgram(1)).rejects.toThrow(
        'Radio programs do not support media groups',
      );
    });

    it('rejects an unknown media group', async () => {
      const { service, prisma } = build();
      prisma.mediaGroup.findUnique.mockResolvedValue(null);
      await expect(service.addMediaGroupToProgram(1)).rejects.toThrow(
        'Media group not found',
      );
    });

    it('does not duplicate an already assigned media group', async () => {
      const { service, prisma } = build();
      prisma.mediaGroup.findUnique.mockResolvedValue({ id: 1 });
      prisma.programMediaGroup.findUnique.mockResolvedValue({ id: 1 });
      const result = await service.addMediaGroupToProgram(1, 'main');
      expect(prisma.programMediaGroup.create).not.toHaveBeenCalled();
      expect(result.version).toBe(1);
    });

    it.each([
      [null, 0],
      [4, 5],
    ])(
      'appends a new media group after max position %s at %s',
      async (max, expected) => {
        const { service, prisma } = build();
        prisma.mediaGroup.findUnique.mockResolvedValue({ id: 2 });
        prisma.programMediaGroup.findUnique.mockResolvedValue(null);
        prisma.programMediaGroup.aggregate.mockResolvedValue({
          _max: { position: max },
        });
        jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
        const result = await service.addMediaGroupToProgram(2);
        expect(prisma.programMediaGroup.create).toHaveBeenCalledWith({
          data: { programStateId: 1, mediaGroupId: 2, position: expected },
        });
        expect(result.version).toBe(0);
      },
    );

    it('falls back to the topic version when the broadcast carries no numeric version', async () => {
      const { service, prisma } = build();
      prisma.mediaGroup.findUnique.mockResolvedValue({ id: 2 });
      prisma.programMediaGroup.findUnique.mockResolvedValue({});
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue({ version: 'x' });
      (service as any).topicVersionByProgramId.state.set('main', 4);
      expect((await service.addMediaGroupToProgram(2)).version).toBe(4);
    });

    it('removes a media group', async () => {
      const { service, prisma } = build();
      const result = await service.removeMediaGroupFromProgram(2);
      expect(prisma.programMediaGroup.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 1, mediaGroupId: 2 },
      });
      expect(result.version).toBe(1);
    });

    it('removing a media group falls back to topic version without broadcast version', async () => {
      const { service } = build();
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      expect((await service.removeMediaGroupFromProgram(2)).version).toBe(0);
    });

    it('fails to remove a media group from a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.removeMediaGroupFromProgram(2)).rejects.toThrow(
        'Program not found',
      );
    });
  });

  describe('stingers', () => {
    it('lists stingers mapped to their public shape', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        stingers: [
          {
            position: 2,
            stinger: {
              id: 4,
              name: 's',
              videoUrl: 'v',
              cutPointMs: 100,
              enabled: true,
              hidden: 1,
            },
          },
        ],
      });
      expect(await service.listProgramStingers()).toEqual([
        {
          id: 4,
          name: 's',
          videoUrl: 'v',
          cutPointMs: 100,
          enabled: true,
          position: 2,
        },
      ]);
    });

    it('throws when listing stingers of a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.listProgramStingers()).rejects.toThrow(
        'Program not found',
      );
    });

    it('rejects stingers on radio programs', async () => {
      const { service } = build({ state: makeState({ type: 'radio' }) });
      await expect(service.addStingerToProgram(1)).rejects.toThrow(
        'Radio programs do not support stingers',
      );
    });

    it('rejects an unknown stinger', async () => {
      const { service, prisma } = build();
      prisma.stinger.findUnique.mockResolvedValue(null);
      await expect(service.addStingerToProgram(1)).rejects.toThrow(
        'Stinger not found',
      );
    });

    it('does not duplicate an assigned stinger', async () => {
      const { service, prisma } = build();
      prisma.stinger.findUnique.mockResolvedValue({ id: 1 });
      prisma.programStinger.findUnique.mockResolvedValue({ id: 1 });
      const result = await service.addStingerToProgram(1);
      expect(prisma.programStinger.create).not.toHaveBeenCalled();
      expect(result.version).toBe(1);
    });

    it.each([
      [null, 0],
      [2, 3],
    ])('appends a stinger after max %s at %s', async (max, expected) => {
      const { service, prisma } = build();
      prisma.stinger.findUnique.mockResolvedValue({ id: 1 });
      prisma.programStinger.findUnique.mockResolvedValue(null);
      prisma.programStinger.aggregate.mockResolvedValue({
        _max: { position: max },
      });
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      const result = await service.addStingerToProgram(1);
      expect(prisma.programStinger.create).toHaveBeenCalledWith({
        data: { programStateId: 1, stingerId: 1, position: expected },
      });
      expect(result.version).toBe(0);
    });

    it('uses topic version when broadcast version is not numeric', async () => {
      const { service, prisma } = build();
      prisma.stinger.findUnique.mockResolvedValue({ id: 1 });
      prisma.programStinger.findUnique.mockResolvedValue({});
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue({});
      (service as any).topicVersionByProgramId.state.set('main', 6);
      expect((await service.addStingerToProgram(1)).version).toBe(6);
    });

    it('removes a stinger', async () => {
      const { service, prisma } = build();
      const result = await service.removeStingerFromProgram(5);
      expect(prisma.programStinger.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 1, stingerId: 5 },
      });
      expect(result.version).toBe(1);
    });

    it('stinger removal falls back to the topic version', async () => {
      const { service } = build();
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      expect((await service.removeStingerFromProgram(5)).version).toBe(0);
    });

    it('fails to remove a stinger from a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.removeStingerFromProgram(5)).rejects.toThrow(
        'Program not found',
      );
    });
  });

  describe('stageScene', () => {
    const scene = { id: 4, name: 'S' };
    it('throws for a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.stageScene(1)).rejects.toThrow('Program not found');
    });

    it('rejects radio programs', async () => {
      const { service } = build({ state: makeState({ type: 'radio' }) });
      await expect(service.stageScene(1)).rejects.toThrow(
        'Radio programs do not support scenes',
      );
    });

    it('rejects scenes not assigned to the program', async () => {
      const { service } = build();
      await expect(service.stageScene(4)).rejects.toThrow(
        new BadRequestException('Scene is not assigned to this program'),
      );
    });

    it.each([null, Number.NaN])(
      'clears the preview when scene id is %s',
      async (id) => {
        const { service, prisma } = build({
          state: makeState({ scenes: [{ sceneId: 4, scene }] }),
        });
        jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
        const result = await service.stageScene(id as number | null);
        expect(prisma.programState.update).toHaveBeenCalledWith({
          where: { id: 1 },
          data: { stagedSceneId: null },
        });
        expect(result).toEqual({
          programId: 'main',
          stagedSceneId: null,
          stagedScene: null,
          version: 0,
        });
      },
    );

    it('stages an assigned scene and reports the broadcast version', async () => {
      const { service } = build({
        state: makeState({ scenes: [{ sceneId: 4, scene }] }),
      });
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      const result = await service.stageScene(4);
      expect(result).toMatchObject({
        stagedSceneId: 4,
        stagedScene: scene,
        version: 1,
      });
      expect(events[0]).toMatchObject({ type: 'scene_staged', scene });
    });

    it('falls back to topic version for non-numeric broadcast version', async () => {
      const { service } = build({
        state: makeState({ scenes: [{ sceneId: 4, scene }] }),
      });
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue({ version: 'n' });
      (service as any).topicVersionByProgramId.state.set('main', 3);
      expect((await service.stageScene(4)).version).toBe(3);
    });
  });

  describe('activateScene', () => {
    const bgMetadata = JSON.stringify({ sceneInstant: { instantId: 3 } });
    const withScene = (extra: Record<string, unknown> = {}) =>
      makeState({
        scenes: [{ sceneId: 5 }],
        activeScene: { id: 5, metadata: bgMetadata },
        ...extra,
      });

    it('throws for a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.activateScene(5)).rejects.toThrow(
        'Program not found',
      );
    });

    it('rejects radio programs', async () => {
      const { service } = build({ state: makeState({ type: 'radio' }) });
      await expect(service.activateScene(5)).rejects.toThrow(
        'Radio programs do not support scenes',
      );
    });

    it('rejects scenes that are not assigned', async () => {
      const { service } = build();
      await expect(service.activateScene(5)).rejects.toThrow(
        'Scene is not assigned to this program',
      );
    });

    it('records a failed handoff and rethrows', async () => {
      const { service, prisma, metrics } = build({ state: withScene() });
      prisma.programState.update.mockRejectedValue(new Error('db down'));
      await expect(service.activateScene(5)).rejects.toThrow('db down');
      expect(metrics.recordSceneHandoff).toHaveBeenCalledWith('failure');
    });

    it('works without a metrics service on success and failure', async () => {
      const ok = build({
        metrics: false,
        state: makeState({
          scenes: [{ sceneId: 5 }],
          activeScene: { metadata: null },
        }),
      });
      await expect(ok.service.activateScene(5)).resolves.toMatchObject({
        version: 1,
      });
      const bad = build({ metrics: false, state: withScene() });
      bad.prisma.programState.update.mockRejectedValue(new Error('boom'));
      await expect(bad.service.activateScene(5)).rejects.toThrow('boom');
    });

    it.each([
      ['  cut  ', 'cut'],
      ['   ', null],
      [null, null],
      [undefined, null],
    ])('normalizes transition id %p to %p', async (input, expected) => {
      const { service, metrics } = build({
        state: makeState({
          scenes: [{ sceneId: 5 }],
          activeScene: null,
        }),
      });
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      await service.activateScene(5, 'main', input as any);
      expect(metrics.recordSceneHandoff).toHaveBeenCalledWith('success');
      expect(events[0]).toMatchObject({
        type: 'scene_change',
        transitionId: expected,
      });
    });

    it('takes the configured background instant', async () => {
      const { service } = build({ state: withScene() });
      const take = jest
        .spyOn(service, 'takeProgramSceneInstant')
        .mockResolvedValue({} as any);
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      await service.activateScene(5);
      expect(take).toHaveBeenCalledWith(5, 'main');
      expect(stop).not.toHaveBeenCalled();
    });

    it.each([
      ['no playback', undefined],
      ['not playing', { isPlaying: false, sceneId: 9 }],
      ['playing same scene', { isPlaying: true, sceneId: 5 }],
    ])('does not fade out with %s', async (_label, playback) => {
      const { service } = build({ state: withScene() });
      if (playback) {
        (service as any).programSceneInstantPlaybackByProgramId.set(
          'main',
          playback,
        );
      }
      jest
        .spyOn(service, 'takeProgramSceneInstant')
        .mockResolvedValue({} as any);
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      await service.activateScene(5);
      expect(stop).not.toHaveBeenCalled();
    });

    it('fades out the previous scene instant for 1500ms before taking the new one', async () => {
      jest.useFakeTimers();
      const { service } = build({ state: withScene() });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        isPlaying: true,
        sceneId: 9,
      });
      const order: string[] = [];
      jest.spyOn(service, 'stopProgramSceneInstant').mockImplementation(((
        ...args: unknown[]
      ) => {
        order.push(`stop:${args[1]}`);
        return Promise.resolve({});
      }) as any);
      jest.spyOn(service, 'takeProgramSceneInstant').mockImplementation((() => {
        order.push('take');
        return Promise.resolve({});
      }) as any);
      const promise = service.activateScene(5);
      await jest.advanceTimersByTimeAsync(1499);
      expect(order).toEqual(['stop:1500']);
      await jest.advanceTimersByTimeAsync(1);
      await promise;
      expect(order).toEqual(['stop:1500', 'take']);
    });

    it.each([
      [new Error('nope'), 'nope'],
      ['plain', 'plain'],
    ])(
      'logs a warning when the background cannot play (%p)',
      async (e, msg) => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { service } = build({ state: withScene() });
        jest.spyOn(service, 'takeProgramSceneInstant').mockRejectedValue(e);
        await expect(service.activateScene(5)).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith(
          'Could not play background instant for scene 5:',
          msg,
        );
      },
    );

    it('stops a playing foreign scene instant when the new scene has no background', async () => {
      const { service } = build({
        state: makeState({
          scenes: [{ sceneId: 5 }],
          activeScene: { metadata: JSON.stringify({ other: 1 }) },
        }),
      });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        isPlaying: true,
        sceneId: 9,
      });
      const stop = jest
        .spyOn(service, 'stopProgramSceneInstant')
        .mockResolvedValue({} as any);
      await service.activateScene(5);
      expect(stop).toHaveBeenCalledWith('main', 1500);
    });

    it.each([
      ['no playback', undefined],
      ['not playing', { isPlaying: false, sceneId: 9 }],
      ['playing same scene', { isPlaying: true, sceneId: 5 }],
    ])('leaves playback alone without background and %s', async (_l, pb) => {
      const { service } = build({
        state: makeState({
          scenes: [{ sceneId: 5 }],
          activeScene: { metadata: '{}' },
        }),
      });
      if (pb) {
        (service as any).programSceneInstantPlaybackByProgramId.set('main', pb);
      }
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      await service.activateScene(5);
      expect(stop).not.toHaveBeenCalled();
    });

    it('uses the topic version when the broadcast has no numeric version', async () => {
      const { service } = build({
        state: makeState({ scenes: [{ sceneId: 5 }] }),
      });
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      (service as any).topicVersionByProgramId.state.set('main', 11);
      expect((await service.activateScene(5)).version).toBe(11);
    });
  });

  describe('setFadeToBlack', () => {
    it('throws for a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.setFadeToBlack(true)).rejects.toThrow(
        'Program not found',
      );
    });

    it('rejects radio programs', async () => {
      const { service } = build({ state: makeState({ type: 'radio' }) });
      await expect(service.setFadeToBlack(true)).rejects.toThrow(
        'Radio programs do not support fade to black',
      );
    });

    it('does not write when the value is unchanged', async () => {
      const { service, prisma } = build();
      const result = await service.setFadeToBlack(false);
      expect(prisma.programState.update).not.toHaveBeenCalled();
      expect(result.version).toBe(0);
    });

    it('reports the version carried by the broadcast payload', async () => {
      const { service } = build();
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue({ version: 12 });
      expect((await service.setFadeToBlack(false)).version).toBe(12);
    });

    it('persists a changed value and falls back to the topic version', async () => {
      const { service, prisma } = build();
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      const result = await service.setFadeToBlack(true);
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { fadeToBlack: true },
      });
      expect(result.stagedSceneId).toBeNull();
      expect(result.version).toBe(0);
    });
  });

  describe('takeProgramOffAir', () => {
    it('throws for a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.takeProgramOffAir()).rejects.toThrow(
        'Program not found',
      );
    });

    it('returns current state without writing when already off air', async () => {
      const { service, prisma } = build();
      (service as any).topicVersionByProgramId.state.set('main', 2);
      const result = await service.takeProgramOffAir();
      expect(prisma.programState.update).not.toHaveBeenCalled();
      expect(result.version).toBe(2);
    });

    it.each([
      ['active scene', { activeSceneId: 2 }],
      ['fade to black', { fadeToBlack: true }],
    ])('takes %s off air and stops a playing scene instant', async (_l, s) => {
      const { service, prisma } = build({ state: makeState(s) });
      (service as any).programSceneInstantPlaybackByProgramId.set('main', {
        isPlaying: true,
      });
      const stop = jest
        .spyOn(service, 'stopProgramSceneInstant')
        .mockResolvedValue({} as any);
      const result = await service.takeProgramOffAir();
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { activeSceneId: null, fadeToBlack: false },
      });
      expect(stop).toHaveBeenCalledWith('main', 1500);
      expect(result.version).toBe(1);
    });

    it('skips stopping when nothing plays and falls back to topic version', async () => {
      const { service } = build({ state: makeState({ activeSceneId: 2 }) });
      const stop = jest.spyOn(service, 'stopProgramSceneInstant');
      jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined);
      expect((await service.takeProgramOffAir()).version).toBe(0);
      expect(stop).not.toHaveBeenCalled();
    });
  });

  describe('song off air', () => {
    const sequence = {
      mode: 'auto',
      activeItemId: 'a',
      items: [],
    };

    it('throws for a missing program', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.takeProgramSongOffAir()).rejects.toThrow(
        'Program not found',
      );
    });

    it('persists manual mode, notifies the engine and the radio', async () => {
      const { service, prisma, engine, radio } = build({
        state: makeState({ songSequence: sequence }),
      });
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      const result = await service.takeProgramSongOffAir();
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { programId: 'main' },
        data: {
          songSequence: { ...sequence, mode: 'manual', activeItemId: null },
        },
      });
      expect(engine.handleSequenceUpdated).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ mode: 'manual', activeItemId: null }),
      );
      expect(radio.stopSong).toHaveBeenCalledWith('main');
      expect(engine.handleStopSong).toHaveBeenCalledWith('main');
      expect(result).toEqual({ ok: true, programId: 'main' });
      expect(events.map((e) => e.type)).toEqual([
        'audio_bus_update',
        'song_off_air',
        'song_playback_update',
      ]);
      expect(
        (service as any).programSongPlaybackByProgramId.get('main'),
      ).toMatchObject({ isPlaying: false, token: '', audioUrl: '' });
    });

    it.each([null, [1, 2], 'text'])(
      'does not rewrite a non-object sequence (%p)',
      async (songSequence) => {
        const { service, prisma, engine } = build({
          state: makeState({ songSequence }),
        });
        await service.takeProgramSongOffAir('main');
        expect(prisma.programState.update).not.toHaveBeenCalled();
        expect(engine.handleSequenceUpdated).not.toHaveBeenCalled();
        expect(engine.handleStopSong).toHaveBeenCalled();
      },
    );

    it('preserves the rotation for timed blocks and skips a not-capable radio', async () => {
      const { service, prisma, engine, radio } = build({
        state: makeState({ songSequence: sequence }),
      });
      radio.getRadioSettings.mockResolvedValue({ enabled: false });
      await service.stopProgramSongForTimedBlock('main');
      expect(prisma.programState.update).not.toHaveBeenCalled();
      expect(engine.handleSequenceUpdated).not.toHaveBeenCalled();
      expect(radio.stopSong).not.toHaveBeenCalled();
      expect(engine.handleStopSong).toHaveBeenCalledWith('main');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('forwardStopSongToRadio skipped'),
      );
    });
  });

  describe('reload and scene lookups', () => {
    it('broadcasts a program reload', async () => {
      const { service } = build();
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      const result = await service.requestProgramReload(' main ');
      expect(result).toMatchObject({ ok: true, programId: 'main' });
      expect(events[0]).toMatchObject({
        type: 'program_reload',
        triggeredAt: result.triggeredAt,
      });
    });

    it('lists program ids by active scene', async () => {
      const { service, prisma } = build();
      prisma.programState.findMany.mockResolvedValue([
        { programId: 'a' },
        { programId: 'b' },
      ]);
      expect(await service.getProgramIdsByActiveScene(3)).toEqual(['a', 'b']);
      expect(prisma.programState.findMany).toHaveBeenCalledWith({
        where: { activeSceneId: 3 },
        select: { programId: true },
      });
    });

    it('clearActiveScene is a no-op without programs', async () => {
      const { service, prisma } = build();
      prisma.programState.findMany.mockResolvedValue([]);
      expect(await service.clearActiveScene(3)).toEqual([]);
      expect(prisma.programState.updateMany).not.toHaveBeenCalled();
    });

    it('clearActiveScene clears programs and stops only matching playback', async () => {
      const { service, prisma } = build();
      prisma.programState.findMany.mockResolvedValue([
        { programId: 'a' },
        { programId: 'b' },
        { programId: 'c' },
        { programId: 'd' },
      ]);
      const map = (service as any).programSceneInstantPlaybackByProgramId;
      map.set('a', { isPlaying: true, sceneId: 3 });
      map.set('b', { isPlaying: true, sceneId: 4 });
      map.set('c', { isPlaying: false, sceneId: 3 });
      const stop = jest
        .spyOn(service, 'stopProgramSceneInstant')
        .mockResolvedValue({} as any);
      expect(await service.clearActiveScene(3)).toEqual(['a', 'b', 'c', 'd']);
      expect(prisma.programState.updateMany).toHaveBeenCalledWith({
        where: { activeSceneId: 3 },
        data: { activeSceneId: null },
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('a', 1500);
    });

    it('returns distinct program ids for an assigned scene', async () => {
      const { service, prisma } = build();
      prisma.programScene.findMany.mockResolvedValue([
        { programState: { programId: 'a' } },
        { programState: { programId: 'a' } },
        { programState: { programId: 'b' } },
      ]);
      expect(await service.getProgramIdsByAssignedScene(1)).toEqual(['a', 'b']);
    });
  });

  describe('instants', () => {
    it('lists instants with song-intro availability', async () => {
      const { service, prisma } = build();
      prisma.instant.findMany.mockResolvedValue([
        { id: 1, songIntro: null },
        { id: 2, songIntro: { songId: 9, programId: 'main' } },
        { id: 3, songIntro: { songId: 8, programId: 'other' } },
      ]);
      expect(await service.listInstants()).toEqual([
        { id: 1, availableForSongIntro: true, assignedSongId: null },
        { id: 2, availableForSongIntro: false, assignedSongId: 9 },
        { id: 3, availableForSongIntro: false, assignedSongId: null },
      ]);
    });

    describe('createInstant', () => {
      it.each([
        [{ name: '  ', audioUrl: 'u' }, 'name is required'],
        [{ name: '', audioUrl: 'u' }, 'name is required'],
        [{ name: undefined as any, audioUrl: 'u' }, 'name is required'],
        [{ name: 'n', audioUrl: ' ' }, 'audioUrl is required'],
        [{ name: 'n', audioUrl: undefined as any }, 'audioUrl is required'],
      ])('validates %p', async (data, message) => {
        const { service } = build();
        await expect(service.createInstant(data)).rejects.toThrow(message);
      });

      it.each([
        [{ volume: 5, enabled: false }, 1, false, 0],
        [{ volume: -3 }, 0, true, 5],
        [{ volume: 0.4, enabled: true }, 0.4, true, 5],
        [{ volume: Number.NaN }, 1, true, 5],
        [{}, 1, true, 5],
      ])('creates with %p', async (extra, volume, enabled, position) => {
        const { service, prisma } = build();
        prisma.instant.aggregate.mockResolvedValue({
          _max: { position: position === 0 ? null : 4 },
        });
        const created = { id: 11 };
        prisma.instant.create.mockResolvedValue(created);
        prisma.instant.findUniqueOrThrow.mockResolvedValue({ id: 11, ok: 1 });
        const result = await service.createInstant({
          name: ' n ',
          audioUrl: ' u ',
          ...extra,
        });
        expect(prisma.instant.create).toHaveBeenCalledWith({
          data: {
            name: 'n',
            audioUrl: 'u',
            volume,
            enabled,
            position,
          },
        });
        expect(syncAudioClipAsset).toHaveBeenCalledWith(prisma, created);
        expect(result).toEqual({ id: 11, ok: 1 });
      });
    });

    describe('updateInstant', () => {
      it('throws when the instant is missing', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue(null);
        await expect(service.updateInstant(1, {})).rejects.toThrow(
          'Instant not found',
        );
      });

      it.each([
        [{ name: '  ' }, 'name cannot be empty'],
        [{ audioUrl: ' ' }, 'audioUrl cannot be empty'],
        [{ volume: Number.NaN }, 'volume must be a number'],
      ])('validates %p', async (data, message) => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue({ id: 1 });
        await expect(service.updateInstant(1, data)).rejects.toThrow(
          new BadRequestException(message),
        );
      });

      it('applies all provided fields', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue({ id: 1 });
        prisma.instant.update.mockResolvedValue({ id: 1, u: 1 });
        prisma.instant.findUniqueOrThrow.mockResolvedValue({ id: 1, done: 1 });
        const result = await service.updateInstant(1, {
          name: ' a ',
          audioUrl: ' b ',
          volume: 9,
          enabled: 0 as any,
        });
        expect(prisma.instant.update).toHaveBeenCalledWith({
          where: { id: 1 },
          data: { name: 'a', audioUrl: 'b', volume: 1, enabled: false },
        });
        expect(syncAudioClipAsset).toHaveBeenCalledWith(prisma, {
          id: 1,
          u: 1,
        });
        expect(result).toEqual({ id: 1, done: 1 });
      });

      it('clamps negative volume and applies nothing else when omitted', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue({ id: 1 });
        prisma.instant.update.mockResolvedValue({ id: 1 });
        prisma.instant.findUniqueOrThrow.mockResolvedValue({ id: 1 });
        await service.updateInstant(1, { volume: -1 });
        expect(prisma.instant.update).toHaveBeenCalledWith({
          where: { id: 1 },
          data: { volume: 0 },
        });
        await service.updateInstant(1, {});
        expect(prisma.instant.update).toHaveBeenLastCalledWith({
          where: { id: 1 },
          data: {},
        });
      });
    });

    describe('deleteInstant', () => {
      it('throws when missing', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue(null);
        await expect(service.deleteInstant(1)).rejects.toThrow(
          'Instant not found',
        );
      });

      it('refuses to delete an instant used as a song intro', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue({
          id: 1,
          position: 0,
          songIntro: { songId: 2 },
        });
        await expect(service.deleteInstant(1)).rejects.toThrow(
          'Instant is assigned as a song intro; remove the assignment before deleting it',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('deletes and compacts positions', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValue({
          id: 1,
          position: 3,
          songIntro: null,
        });
        expect(await service.deleteInstant(1)).toEqual({ deletedInstantId: 1 });
        expect(prisma.instant.delete).toHaveBeenCalledWith({
          where: { id: 1 },
        });
        expect(deleteMediaAsset).toHaveBeenCalledWith(
          prisma,
          MediaAssetKind.AUDIO_CLIP,
          1,
        );
        expect(prisma.instant.updateMany).toHaveBeenNthCalledWith(1, {
          where: { position: { gt: 3 } },
          data: { position: { increment: 1_000_000 } },
        });
        expect(prisma.instant.updateMany).toHaveBeenNthCalledWith(2, {
          where: { position: { gt: 1_000_003 } },
          data: { position: { decrement: 1_000_001 } },
        });
      });
    });

    describe('playInstant / stopAllInstants', () => {
      const instant = { id: 1, name: 'n', audioUrl: 'u', volume: 0.5 };
      it('throws when missing or disabled', async () => {
        const { service, prisma } = build();
        prisma.instant.findUnique.mockResolvedValueOnce(null);
        await expect(service.playInstant(1)).rejects.toThrow(
          'Instant not found',
        );
        prisma.instant.findUnique.mockResolvedValueOnce({
          ...instant,
          enabled: false,
        });
        await expect(service.playInstant(1)).rejects.toThrow(
          'Instant is disabled',
        );
      });

      it('broadcasts and forwards to a radio-capable program', async () => {
        const { service, prisma, radio } = build();
        prisma.instant.findUnique.mockResolvedValue({
          ...instant,
          enabled: true,
        });
        const events: any[] = [];
        service.addEventListener((e) => events.push(e.data));
        expect(await service.playInstant(1)).toEqual({ ok: true });
        expect(events[0]).toMatchObject({
          type: 'instant_play',
          instant: { id: 1, name: 'n', audioUrl: 'u', volume: 0.5 },
        });
        expect(radio.playInstant).toHaveBeenCalledWith('main', 'u', 0.5);
      });

      it('does not forward when the radio is not capable', async () => {
        const { service, prisma, radio } = build();
        prisma.instant.findUnique.mockResolvedValue({
          ...instant,
          enabled: true,
        });
        radio.getRadioSettings.mockResolvedValue(null);
        await service.playInstant(1, 'x');
        expect(radio.playInstant).not.toHaveBeenCalled();
      });

      it('stops all instants only on capable radios', async () => {
        const { service, radio } = build();
        const events: any[] = [];
        service.addEventListener((e) => events.push(e.data));
        expect(await service.stopAllInstants()).toEqual({ ok: true });
        expect(radio.stopAllInstants).toHaveBeenCalledWith('main');
        expect(events[0].type).toBe('instant_stop_all');
        radio.getRadioSettings.mockRejectedValue(new Error('down'));
        radio.stopAllInstants.mockClear();
        await service.stopAllInstants('main');
        expect(radio.stopAllInstants).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
          '[ProgramService] isRadioCapable(main) = false (error)',
        );
      });
    });
  });

  describe('broadcasting', () => {
    it('broadcastUpdate versions known events and passes unknown through', () => {
      const { service } = build();
      const seen: any[] = [];
      (service as any)
        .getEventSubject('main')
        .subscribe((d: any) => seen.push(d));
      expect(service.broadcastUpdate('main', { type: 'scene_change' })).toEqual(
        {
          type: 'scene_change',
          version: 1,
        },
      );
      expect(service.broadcastUpdate('main', { type: 'mystery' })).toEqual({
        type: 'mystery',
      });
      expect(seen).toHaveLength(2);
    });

    it('notifies listeners, swallows listener errors and supports unsubscribe', () => {
      const { service } = build();
      const good = jest.fn();
      const bad = jest.fn(() => {
        throw new Error('listener');
      });
      service.broadcastUpdate('main', { type: 'scene_change' });
      const offBad = service.addEventListener(bad);
      const offGood = service.addEventListener(good);
      service.broadcastUpdate('main', { type: 'scene_change' });
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledWith({
        scope: 'program',
        programId: 'main',
        data: { type: 'scene_change', version: 2 },
      });
      offBad();
      offGood();
      service.broadcastUpdate('main', { type: 'scene_change' });
      expect(good).toHaveBeenCalledTimes(1);
    });

    it('broadcasts globally to every program subject and listener', () => {
      const { service } = build();
      const a = jest.fn();
      const b = jest.fn();
      (service as any).getEventSubject('a').subscribe(a);
      (service as any).getEventSubject('b').subscribe(b);
      (service as any).broadcastGlobalUpdate({ type: 'x' });
      const listener = jest.fn();
      service.addEventListener(listener);
      (service as any).broadcastGlobalUpdate('raw');
      expect(a).toHaveBeenNthCalledWith(1, { type: 'x', version: 1 });
      expect(b).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledWith({
        scope: 'global',
        programId: null,
        data: { type: 'global_update', payload: 'raw', version: 2 },
      });
      expect(service.getGlobalBroadcastVersion()).toBe(2);
    });
  });

  describe('engine events', () => {
    const playbackData = {
      token: 't',
      audioUrl: 'a',
      title: 'T',
      artist: 'A',
      coverUrl: 'c',
      progress: 0.5,
      positionMs: 10,
      durationMs: 100,
      isPlaying: true,
      startedAt: 's',
      updatedAt: 'u',
      telemetryStale: false,
      introStatus: 'none',
      introFailureReason: null,
      queueEntryId: 'q',
    };
    const expectedPlayback = {
      token: 't',
      audioUrl: 'a',
      title: 'T',
      artist: 'A',
      coverUrl: 'c',
      progress: 0.5,
      currentTimeMs: 10,
      durationMs: 100,
      isPlaying: true,
      startedAt: 's',
      updatedAt: 'u',
      telemetryStale: false,
      introStatus: 'none',
      introFailureReason: null,
      queueEntryId: 'q',
    };

    it('registers the engine handler on init and routes events', async () => {
      const { service, engine, confidence, prisma } = build();
      await service.onModuleInit();
      const handler = engine.setBroadcastHandler.mock.calls[0][0];
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      const event = {
        type: 'radio_leg_status',
        programId: ' main ',
        status: 'live',
      };
      handler(event);
      expect(confidence.observe).toHaveBeenCalledWith(event);
      expect(events[0]).toMatchObject({
        type: 'radio_leg_status',
        programId: 'main',
        status: 'live',
      });
      expect(prisma.programState.upsert).toHaveBeenCalledTimes(1);
    });

    it.each(['playback_update', 'song_playback_active'])(
      'maps %s to a song_playback_update',
      (type) => {
        const { service } = build();
        const events: any[] = [];
        service.addEventListener((e) => events.push(e.data));
        (service as any).handleEngineEvent({
          type,
          programId: 'main',
          playback: playbackData,
        });
        expect(events[0]).toMatchObject({
          type: 'song_playback_update',
          programId: 'main',
          playback: expectedPlayback,
        });
        expect(
          (service as any).programSongPlaybackByProgramId.get('main'),
        ).toEqual(expectedPlayback);
      },
    );

    it('derives the off-air playback from the previous playback', () => {
      const { service } = build();
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      (service as any).programSongPlaybackByProgramId.set(
        'main',
        expectedPlayback,
      );
      (service as any).handleEngineEvent({
        type: 'song_off_air',
        programId: 'main',
        triggeredAt: 'now',
      });
      expect(events[0]).toMatchObject({
        type: 'song_off_air',
        triggeredAt: 'now',
        playback: {
          ...expectedPlayback,
          isPlaying: false,
          updatedAt: 'now',
          telemetryStale: false,
        },
      });
    });

    it('defaults the off-air playback without a previous playback', () => {
      const { service } = build();
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      (service as any).handleEngineEvent({
        type: 'song_off_air',
        programId: 'main',
        triggeredAt: 'now',
      });
      expect(events[0].playback).toEqual({
        token: '',
        audioUrl: '',
        title: undefined,
        artist: undefined,
        coverUrl: undefined,
        progress: 0,
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
        startedAt: undefined,
        updatedAt: 'now',
        telemetryStale: false,
        introStatus: 'none',
        introFailureReason: null,
        queueEntryId: null,
      });
    });

    it.each([
      [{}, false],
      [{ songSequence: null }, true],
      [{ songSequence: { items: [] } }, true],
    ])('forwards queue updates with %p', (extra, hasSequence) => {
      const { service } = build();
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      (service as any).handleEngineEvent({
        type: 'song_queue_update',
        programId: 'main',
        songQueue: [{ id: 1 }],
        ...extra,
      });
      expect(events[0].songQueue).toEqual([{ id: 1 }]);
      expect('songSequence' in events[0]).toBe(hasSequence);
      expect(events[0].type).toBe('song_queue_update');
    });

    it.each([
      [
        { rms: 0.2, peak: 0.3 },
        { rms: 0.5, peak: 0.1 },
        { vu: 0.5, peak: 0.3 },
      ],
      [{ rms: 0.2, peak: 0.3 }, undefined, { vu: 0.2, peak: 0.3 }],
    ])('computes audio meter levels (intro %p)', (song, intro, expected) => {
      const { service } = build();
      const events: any[] = [];
      service.addEventListener((e) => events.push(e.data));
      const levels = {
        song,
        intro,
        instant: { rms: 0.4, peak: 0.6 },
        output: { rms: 0.7, peak: 0.9 },
      };
      (service as any).handleEngineEvent({
        type: 'audio_levels',
        programId: 'main',
        levels,
        sampledAt: 'ts',
      });
      expect(events[0]).toEqual({
        type: 'palazzo_audio_levels',
        programId: 'main',
        levels,
        sampledAt: 'ts',
      });
      const meter = {
        song: { vu: expected.vu, peak: expected.peak, peakHold: expected.peak },
        instants: { vu: 0.4, peak: 0.6, peakHold: 0.6 },
        sceneInstant: { vu: 0, peak: 0, peakHold: 0 },
        main: { vu: 0.7, peak: 0.9, peakHold: 0.9 },
        updatedAt: 'ts',
      };
      expect(events[1]).toMatchObject({
        type: 'audio_meter_update',
        levels: meter,
      });
      expect((service as any).programAudioMeterByProgramId.get('main')).toEqual(
        meter,
      );
    });

    it('ignores unknown engine events', () => {
      const { service, confidence } = build();
      const listener = jest.fn();
      service.addEventListener(listener);
      (service as any).handleEngineEvent({ type: 'other', programId: 'main' });
      expect(confidence.observe).toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('tolerates a missing output-confidence service', () => {
      const prisma: any = {};
      const service = new ProgramService(prisma, {} as any, {} as any);
      const listener = jest.fn();
      service.addEventListener(listener);
      (service as any).handleEngineEvent({
        type: 'radio_leg_status',
        programId: 'main',
        status: 's',
      });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('radio forwarding', () => {
    it('forwardSongToRadio skips when not capable', async () => {
      const { service, radio } = build();
      radio.getRadioSettings.mockResolvedValue({ enabled: false });
      await (service as any).forwardSongToRadio('main', 'u');
      expect(radio.playSong).not.toHaveBeenCalled();
    });

    it('forwardSongToRadio plays and rejects a refused command', async () => {
      const { service, radio } = build();
      await (service as any).forwardSongToRadio('main', 'u');
      expect(radio.playSong).toHaveBeenCalledWith('main', 'u');
      radio.playSong.mockResolvedValue({ ok: false });
      await expect(
        (service as any).forwardSongToRadio('main', 'u'),
      ).rejects.toThrow(
        new BadGatewayException('Palazzo rejected the song command'),
      );
    });

    it('treats radio settings that are null or throw as incapable', async () => {
      const { service, radio } = build();
      radio.getRadioSettings.mockResolvedValueOnce(null);
      expect(await (service as any).isRadioCapable('p')).toBe(false);
      radio.getRadioSettings.mockRejectedValueOnce(new Error('x'));
      expect(await (service as any).isRadioCapable('p')).toBe(false);
      radio.getRadioSettings.mockResolvedValueOnce({ enabled: true });
      expect(await (service as any).isRadioCapable('p')).toBe(true);
    });
  });

  describe('getEventStream', () => {
    const flush = () => jest.advanceTimersByTimeAsync(0);
    const stateOf = (extra: Record<string, unknown> = {}) =>
      ({ id: 1, programId: 'main', version: 5, ...extra }) as any;

    it('delivers the snapshot first, then buffered and live events', async () => {
      jest.useFakeTimers();
      const { service, metrics } = build();
      let resolveState!: (v: any) => void;
      jest
        .spyOn(service, 'getState')
        .mockReturnValue(new Promise((r) => (resolveState = r)));
      const out: any[] = [];
      const sub = service.getEventStream(' main ').subscribe((m) => {
        out.push(JSON.parse(m.data));
      });
      expect(metrics.recordProgramSseConnection).toHaveBeenCalledWith(1);
      service.broadcastUpdate('main', { type: 'scene_change', n: 'early' });
      expect(out).toEqual([]);
      resolveState(stateOf());
      await flush();
      expect(out[0]).toEqual({
        type: 'program_state_snapshot',
        programId: 'main',
        state: stateOf(),
        version: 5,
      });
      expect(out[1]).toMatchObject({ n: 'early' });
      service.broadcastUpdate('main', { type: 'scene_change', n: 'live' });
      expect(out[2]).toMatchObject({ n: 'live' });
      expect(metrics.recordProgramSseSnapshot).toHaveBeenCalledWith('success');
      sub.unsubscribe();
      expect(metrics.recordProgramSseConnection).toHaveBeenLastCalledWith(-1);
    });

    it('projects state and signals through the template manifest with heartbeats', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { service } = build();
      jest.spyOn(service, 'getState').mockResolvedValue(
        stateOf({
          templateManifest,
          activeSceneId: 2,
          secret: 'hidden',
        }),
      );
      const out: any[] = [];
      const sub = service
        .getEventStream('main')
        .subscribe((m) => out.push(JSON.parse(m.data)));
      await flush();
      expect(out[0]).toMatchObject({
        type: 'program_state_snapshot',
        schemaVersion: 1,
        version: 5,
        state: { schemaVersion: 1, activeSceneId: 2 },
      });
      expect(out[0].state).not.toHaveProperty('secret');
      service.broadcastUpdate('main', { type: 'not_allowed' });
      service.broadcastUpdate('main', { type: 'scene_update', x: 1 });
      expect(out).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(out[1]).toMatchObject({
        type: 'heartbeat',
        programId: 'main',
        sentAt: '2026-01-01T00:00:15.000Z',
      });
      sub.unsubscribe();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(out).toHaveLength(2);
    });

    it('does not start a heartbeat when the manifest lacks the signal', async () => {
      jest.useFakeTimers();
      const { service } = build();
      jest
        .spyOn(service, 'getState')
        .mockResolvedValue(
          stateOf({ templateManifest: templateManifestNoHeartbeat }),
        );
      const out: any[] = [];
      const sub = service.getEventStream('main').subscribe((m) => out.push(m));
      await flush();
      await jest.advanceTimersByTimeAsync(45_000);
      expect(out).toHaveLength(1);
      sub.unsubscribe();
    });

    it('ignores a snapshot resolved after the stream closed', async () => {
      jest.useFakeTimers();
      const { service, metrics } = build();
      let resolveState!: (v: any) => void;
      jest
        .spyOn(service, 'getState')
        .mockReturnValue(new Promise((r) => (resolveState = r)));
      const out: any[] = [];
      const sub = service.getEventStream('main').subscribe((m) => out.push(m));
      sub.unsubscribe();
      resolveState(stateOf());
      await flush();
      expect(out).toEqual([]);
      expect(metrics.recordProgramSseSnapshot).not.toHaveBeenCalled();
    });

    it('errors the subscriber when the snapshot fails', async () => {
      jest.useFakeTimers();
      const { service, metrics } = build();
      jest.spyOn(service, 'getState').mockRejectedValue(new Error('nope'));
      const error = jest.fn();
      service.getEventStream('main').subscribe({ error });
      await flush();
      expect(error).toHaveBeenCalledWith(new Error('nope'));
      expect(metrics.recordProgramSseSnapshot).toHaveBeenCalledWith('failure');
    });

    it('swallows a snapshot failure after the stream closed', async () => {
      jest.useFakeTimers();
      const { service, metrics } = build();
      let rejectState!: (e: unknown) => void;
      jest
        .spyOn(service, 'getState')
        .mockReturnValue(new Promise((_r, rej) => (rejectState = rej)));
      const error = jest.fn();
      const sub = service.getEventStream('main').subscribe({ error });
      sub.unsubscribe();
      rejectState(new Error('late'));
      await flush();
      expect(error).not.toHaveBeenCalled();
      expect(metrics.recordProgramSseSnapshot).not.toHaveBeenCalled();
    });

    it('propagates subject errors and works without a metrics service', async () => {
      jest.useFakeTimers();
      const { service } = build({ metrics: false });
      jest.spyOn(service, 'getState').mockResolvedValue(stateOf());
      const error = jest.fn();
      const sub = service.getEventStream().subscribe({ error });
      await flush();
      (service as any).getEventSubject('main').error(new Error('subject'));
      expect(error).toHaveBeenCalledWith(new Error('subject'));
      sub.unsubscribe();
    });
  });
});
