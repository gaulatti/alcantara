import { BadRequestException, StreamableFile } from '@nestjs/common';
import { of } from 'rxjs';
import { ProgramController } from './program.controller';

type Mocks = Record<string, jest.Mock>;
const sentinel = (name: string) => ({ result: name });

function build() {
  const program: Mocks = {};
  for (const name of [
    'listPrograms',
    'createProgram',
    'renameProgram',
    'deleteProgram',
    'getBroadcastSettings',
    'updateBroadcastSettings',
    'getPublicState',
    'getProgramAudioBus',
    'getProgramAudioMeter',
    'updateProgramAudioMeter',
    'getProgramSceneInstantPlayback',
    'takeProgramSceneInstant',
    'stopProgramSceneInstant',
    'getProgramSongPlayback',
    'enqueueProgramSong',
    'reorderProgramSongQueue',
    'removeQueuedProgramSong',
    'updateProgramSongPlayback',
    'getState',
    'addSceneToProgram',
    'removeSceneFromProgram',
    'listProgramMediaGroups',
    'addMediaGroupToProgram',
    'removeMediaGroupFromProgram',
    'listProgramStingers',
    'addStingerToProgram',
    'removeStingerFromProgram',
    'activateScene',
    'getStagedScene',
    'stageScene',
    'setFadeToBlack',
    'takeProgramOffAir',
    'takeProgramSongOffAir',
    'requestProgramReload',
    'updateProgramAudioBus',
    'getEventStream',
  ]) {
    program[name] = jest.fn().mockResolvedValue(sentinel(name));
  }
  program.proxyAudio = jest.fn().mockResolvedValue({
    buffer: Buffer.from('audio-bytes'),
    contentType: 'audio/mpeg',
  });
  const stream = of({ data: 'event' });
  program.getEventStream = jest.fn().mockReturnValue(stream);
  const flight: Mocks = {};
  for (const name of [
    'listFlightSequences',
    'createFlightSequence',
    'updateFlightSequence',
    'generateTaggedLog',
    'fillRundown',
    'preflightFlightSequence',
    'publishFlightSequence',
    'deleteFlightSequence',
    'activateFlightSequence',
    'deactivateFlightSequence',
    'start',
    'stop',
    'go',
    'reset',
  ]) {
    flight[name] = jest.fn().mockResolvedValue(sentinel(name));
  }
  const template: Mocks = {
    inspect: jest.fn().mockResolvedValue(sentinel('inspect')),
  };
  const controller = new ProgramController(
    program as never,
    flight as never,
    template as never,
  );
  return { controller, program, flight, template, stream };
}

describe('ProgramController delegation', () => {
  it('lists programs and removes them', async () => {
    const { controller, program } = build();
    await expect(controller.listPrograms()).resolves.toEqual(
      sentinel('listPrograms'),
    );
    await expect(controller.deleteProgram('p')).resolves.toEqual(
      sentinel('deleteProgram'),
    );
    expect(program.deleteProgram).toHaveBeenCalledWith('p');
  });

  it('delegates broadcast settings reads and writes', async () => {
    const { controller, program } = build();
    const body = { enabled: true, startTime: null };
    await expect(controller.getBroadcastSettings()).resolves.toEqual(
      sentinel('getBroadcastSettings'),
    );
    await expect(controller.updateBroadcastSettings(body)).resolves.toEqual(
      sentinel('updateBroadcastSettings'),
    );
    expect(program.updateBroadcastSettings).toHaveBeenCalledWith(body);
  });

  it('delegates program-scoped reads', async () => {
    const { controller, program } = build();
    const reads: Array<[string, () => Promise<unknown>, string | undefined]> = [
      ['getPublicState', () => controller.getStateById('p'), 'p'],
      ['getProgramAudioBus', () => controller.getProgramAudioBusById('p'), 'p'],
      [
        'getProgramAudioMeter',
        () => controller.getProgramAudioMeterById('p'),
        'p',
      ],
      [
        'getProgramSceneInstantPlayback',
        () => controller.getProgramSceneInstantById('p'),
        'p',
      ],
      [
        'getProgramSongPlayback',
        () => controller.getProgramSongPlaybackById('p'),
        'p',
      ],
      [
        'listProgramMediaGroups',
        () => controller.listProgramMediaGroups('p'),
        'p',
      ],
      ['listProgramStingers', () => controller.listProgramStingers('p'), 'p'],
      ['getStagedScene', () => controller.getStagedSceneById('p'), 'p'],
      ['getState', () => controller.getState(), undefined],
    ];
    for (const [method, call, arg] of reads) {
      await expect(call()).resolves.toEqual(sentinel(method));
      if (arg === undefined) expect(program[method]).toHaveBeenCalledWith();
      else expect(program[method]).toHaveBeenCalledWith(arg);
    }
  });

  it('delegates audio meter and song playback updates with the program id last', async () => {
    const { controller, program } = build();
    const meter = { song: 1 };
    const playback = { token: 't', isPlaying: true };
    await controller.updateProgramAudioMeterById('p', meter);
    await controller.updateProgramSongPlaybackById('p', playback);
    await controller.updateProgramAudioBusById('p', { songSequence: [] });
    expect(program.updateProgramAudioMeter).toHaveBeenCalledWith(meter, 'p');
    expect(program.updateProgramSongPlayback).toHaveBeenCalledWith(
      playback,
      'p',
    );
    expect(program.updateProgramAudioBus).toHaveBeenCalledWith(
      { songSequence: [] },
      'p',
    );
  });

  it('delegates scene, media group and stinger membership', async () => {
    const { controller, program } = build();
    await controller.addSceneToProgram('p', { sceneId: 4 });
    await controller.removeSceneFromProgram('p', '5');
    await controller.addMediaGroupToProgram('p', { mediaGroupId: 6 });
    await controller.removeMediaGroupFromProgram('p', '7');
    await controller.addStingerToProgram('p', { stingerId: 8 });
    await controller.removeStingerFromProgram('p', '9');
    expect(program.addSceneToProgram).toHaveBeenCalledWith(4, 'p');
    expect(program.removeSceneFromProgram).toHaveBeenCalledWith(5, 'p');
    expect(program.addMediaGroupToProgram).toHaveBeenCalledWith(6, 'p');
    expect(program.removeMediaGroupFromProgram).toHaveBeenCalledWith(7, 'p');
    expect(program.addStingerToProgram).toHaveBeenCalledWith(8, 'p');
    expect(program.removeStingerFromProgram).toHaveBeenCalledWith(9, 'p');
  });

  it('delegates activation, off-air and reload for a program and for the default program', async () => {
    const { controller, program } = build();
    await controller.activateSceneById('p', { sceneId: 3, transitionId: 'tr' });
    await controller.activateScene({ sceneId: 3, transitionId: 'tr' });
    await controller.activateScene({ sceneId: 4 });
    expect(program.activateScene).toHaveBeenNthCalledWith(1, 3, 'p', 'tr');
    expect(program.activateScene).toHaveBeenNthCalledWith(
      2,
      3,
      undefined,
      'tr',
    );
    expect(program.activateScene).toHaveBeenNthCalledWith(
      3,
      4,
      undefined,
      undefined,
    );

    await controller.takeProgramOffAirById('p');
    await controller.takeProgramOffAir();
    await controller.takeProgramSongOffAirById('p');
    await controller.takeProgramSongOffAir();
    await controller.reloadProgramById('p');
    await controller.reloadProgram();
    expect(program.takeProgramOffAir.mock.calls).toEqual([['p'], []]);
    expect(program.takeProgramSongOffAir.mock.calls).toEqual([['p'], []]);
    expect(program.requestProgramReload.mock.calls).toEqual([['p'], []]);
  });

  it('delegates scene instant stop and the song queue', async () => {
    const { controller, program } = build();
    await controller.stopProgramSceneInstantById('p');
    await controller.removeQueuedProgramSongById('p', 'e1');
    expect(program.stopProgramSceneInstant).toHaveBeenCalledWith('p');
    expect(program.removeQueuedProgramSong).toHaveBeenCalledWith('p', 'e1');
  });

  it('streams events for one program or for the default program', () => {
    const { controller, program, stream } = build();
    expect(controller.eventsById('p')).toBe(stream);
    expect(controller.events()).toBe(stream);
    expect(program.getEventStream.mock.calls).toEqual([['p'], []]);
  });

  it('serves proxied audio as an inline streamable file with the upstream type', async () => {
    const { controller, program } = build();
    const file = await controller.proxyAudio('https://x.test/a.mp3');
    expect(program.proxyAudio).toHaveBeenCalledWith('https://x.test/a.mp3');
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders()).toEqual({
      type: 'audio/mpeg',
      disposition: 'inline',
      length: 11,
    });
  });
});

describe('ProgramController input normalization', () => {
  it.each([
    [
      'numbers',
      { sceneId: 3, instantId: 4, mediaAssetId: ' m1 ' },
      [3, 4, 'm1'],
    ],
    [
      'non-finite numbers',
      { sceneId: NaN, instantId: Infinity },
      [null, null, null],
    ],
    [
      'wrong types',
      { sceneId: '3', instantId: '4', mediaAssetId: 5 },
      [null, null, null],
    ],
    ['a blank media asset', { mediaAssetId: '   ' }, [null, null, null]],
    [
      'nulls',
      { sceneId: null, instantId: null, mediaAssetId: null },
      [null, null, null],
    ],
    ['no body', undefined, [null, null, null]],
  ])(
    'normalizes a scene instant take with %s',
    async (_label, body, expected) => {
      const { controller, program } = build();
      await controller.takeProgramSceneInstantById('p', body as never);
      expect(program.takeProgramSceneInstant).toHaveBeenCalledWith(
        expected[0],
        'p',
        expected[1],
        expected[2],
      );
    },
  );

  it('enqueues the item id only when it is a string', async () => {
    const { controller, program } = build();
    await controller.enqueueProgramSongById('p', { itemId: 'i1' });
    await controller.enqueueProgramSongById('p', { itemId: 4 as never });
    await controller.enqueueProgramSongById('p', undefined as never);
    expect(program.enqueueProgramSong.mock.calls).toEqual([
      ['p', 'i1'],
      ['p', ''],
      ['p', ''],
    ]);
  });

  it('reorders the song queue only with an array of entries', async () => {
    const { controller, program } = build();
    await controller.reorderProgramSongQueueById('p', { entryIds: ['b', 'a'] });
    await controller.reorderProgramSongQueueById('p', {
      entryIds: 'b' as never,
    });
    await controller.reorderProgramSongQueueById('p', undefined as never);
    expect(program.reorderProgramSongQueue.mock.calls).toEqual([
      ['p', ['b', 'a']],
      ['p', []],
      ['p', []],
    ]);
  });

  it('stages a scene only for finite numeric ids', async () => {
    const { controller, program } = build();
    await controller.stageSceneById('p', { sceneId: 9 });
    await controller.stageSceneById('p', { sceneId: null });
    await controller.stageSceneById('p', { sceneId: NaN });
    await controller.stageSceneById('p', { sceneId: '9' as never });
    await controller.stageSceneById('p', undefined as never);
    expect(program.stageScene.mock.calls).toEqual([
      [9, 'p'],
      [null, 'p'],
      [null, 'p'],
      [null, 'p'],
      [null, 'p'],
    ]);
  });

  it('enables fade to black only for an explicit true', async () => {
    const { controller, program } = build();
    await controller.setFadeToBlackById('p', { active: true });
    await controller.setFadeToBlackById('p', { active: false });
    await controller.setFadeToBlackById('p', { active: 'true' as never });
    await controller.setFadeToBlackById('p', undefined as never);
    expect(program.setFadeToBlack.mock.calls).toEqual([
      [true, 'p'],
      [false, 'p'],
      [false, 'p'],
      [false, 'p'],
    ]);
  });
});

describe('ProgramController templates', () => {
  it.each([
    ['missing', {}],
    ['non-string', { templateUrl: 5 as never }],
    ['blank', { templateUrl: '   ' }],
    ['no body', undefined as never],
  ])('rejects template inspection with a %s URL', async (_label, body) => {
    const { controller, template } = build();
    await expect(controller.inspectTemplate(body)).rejects.toThrow(
      new BadRequestException('templateUrl is required'),
    );
    expect(template.inspect).not.toHaveBeenCalled();
  });

  it('inspects a supplied template URL', async () => {
    const { controller, template } = build();
    await expect(
      controller.inspectTemplate({ templateUrl: 'https://cdn.example/m.json' }),
    ).resolves.toEqual(sentinel('inspect'));
    expect(template.inspect).toHaveBeenCalledWith('https://cdn.example/m.json');
  });

  it('creates a program without touching the template when no URL is given', async () => {
    const { controller, program, template } = build();
    await controller.createProgram({ programId: 'p' });
    expect(template.inspect).not.toHaveBeenCalled();
    expect(program.createProgram).toHaveBeenCalledWith(
      'p',
      undefined,
      undefined,
    );
  });

  it('clears the template for null or blank URLs on rename', async () => {
    const { controller, program, template } = build();
    await controller.renameProgram('p', {
      nextProgramId: 'q',
      templateUrl: '  ',
    });
    await controller.renameProgram('p', {
      nextProgramId: 'q',
      type: 'tv',
      templateUrl: null,
    });
    expect(template.inspect).not.toHaveBeenCalled();
    expect(program.renameProgram.mock.calls).toEqual([
      ['p', 'q', undefined, null],
      ['p', 'q', 'tv', null],
    ]);
  });

  it('refuses visual templates on radio programs before any network request', async () => {
    const { controller, program, template } = build();
    await expect(
      controller.createProgram({
        programId: 'r',
        type: 'radio',
        templateUrl: 'https://cdn.example/m.json',
      }),
    ).rejects.toThrow('Radio programs do not support visual templates');
    await expect(
      controller.renameProgram('r', {
        nextProgramId: 'r',
        type: 'radio',
        templateUrl: 'https://cdn.example/m.json',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(template.inspect).not.toHaveBeenCalled();
    expect(program.createProgram).not.toHaveBeenCalled();
    expect(program.renameProgram).not.toHaveBeenCalled();
  });

  it('allows radio programs with no, null or blank template URL', async () => {
    const { controller, program } = build();
    await controller.createProgram({ programId: 'r', type: 'radio' });
    await controller.createProgram({
      programId: 'r',
      type: 'radio',
      templateUrl: '  ',
    });
    await controller.createProgram({
      programId: 'r',
      type: 'radio',
      templateUrl: null,
    });
    expect(program.createProgram.mock.calls).toEqual([
      ['r', 'radio', undefined],
      ['r', 'radio', null],
      ['r', 'radio', null],
    ]);
  });
});

describe('ProgramController flight routes', () => {
  it('delegates sequence CRUD with numeric ids', async () => {
    const { controller, flight } = build();
    const created = { name: 'n', items: [] };
    const updated = { name: 'm', revision: 2 };
    await controller.listFlightSequencesById('p');
    await controller.createFlightSequenceById('p', created);
    await controller.updateFlightSequenceById('p', '12', updated);
    await controller.deleteFlightSequenceById('p', '12');
    expect(flight.listFlightSequences).toHaveBeenCalledWith('p');
    expect(flight.createFlightSequence).toHaveBeenCalledWith('p', created);
    expect(flight.updateFlightSequence).toHaveBeenCalledWith('p', 12, updated);
    expect(flight.deleteFlightSequence).toHaveBeenCalledWith('p', 12);
  });

  it('delegates generation, filling, preflight and publishing', async () => {
    const { controller, flight } = build();
    const body = { revision: 3, rules: { a: 1 } };
    await controller.generateTaggedLog('p', '4', body);
    await controller.fillRundown('p', '4', { ...body, items: [] });
    await controller.preflightFlightSequenceById('p', '4');
    await controller.publishFlightSequenceById('p', '4', { revision: 3 });
    expect(flight.generateTaggedLog).toHaveBeenCalledWith('p', 4, body);
    expect(flight.fillRundown).toHaveBeenCalledWith('p', 4, {
      ...body,
      items: [],
    });
    expect(flight.preflightFlightSequence).toHaveBeenCalledWith('p', 4);
    expect(flight.publishFlightSequence).toHaveBeenCalledWith('p', 4, 3);
  });

  it('delegates activation and transport controls', async () => {
    const { controller, flight } = build();
    await controller.activateFlightSequenceById('p', '4');
    await controller.deactivateFlightSequenceById('p');
    await controller.startFlightById('p');
    await controller.stopFlightById('p');
    await controller.goFlightById('p');
    await controller.resetFlightById('p');
    expect(flight.activateFlightSequence).toHaveBeenCalledWith('p', 4);
    for (const method of [
      'deactivateFlightSequence',
      'start',
      'stop',
      'go',
      'reset',
    ]) {
      expect(flight[method]).toHaveBeenCalledWith('p');
    }
  });
});

describe('ProgramController decorator metadata', () => {
  const metadata = (key: string, target: object, property?: string) =>
    property === undefined
      ? Reflect.getMetadata(key, target)
      : Reflect.getMetadata(key, target, property);

  it('declares its three collaborators as constructor dependencies', () => {
    const types = metadata('design:paramtypes', ProgramController) as Array<{
      name: string;
    }>;
    expect(types.map((type) => type.name)).toEqual([
      'ProgramService',
      'FlightService',
      'ProgramTemplateService',
    ]);
  });

  it('falls back to generic metadata types when collaborators are unavailable at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('./program.service', () => ({}));
      jest.doMock('./flight.service', () => ({}));
      jest.doMock('./program-template.service', () => ({}));
      jest.doMock('rxjs', () => ({
        ...jest.requireActual('rxjs'),
        Observable: undefined,
      }));
      jest.doMock('@nestjs/common', () => ({
        ...jest.requireActual('@nestjs/common'),
        StreamableFile: undefined,
      }));
      for (const dependency of [
        '@nestjs/common',
        'rxjs',
        '../auth/permissions',
        '../auth/public.decorator',
        '../auth/require-permission.decorator',
      ]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require(dependency);
      }
      const realPromise = global.Promise;
      let isolated: { ProgramController: typeof ProgramController };
      try {
        (global as { Promise?: PromiseConstructor }).Promise = undefined;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        isolated = require('./program.controller');
      } finally {
        global.Promise = realPromise;
      }
      const target = isolated.ProgramController;
      expect(Reflect.getMetadata('design:paramtypes', target)).toEqual([
        Object,
        Object,
        Object,
      ]);
      expect(
        Reflect.getMetadata(
          'design:returntype',
          target.prototype,
          'proxyAudio',
        ),
      ).toBe(Object);
      for (const method of ['events', 'eventsById']) {
        expect(
          Reflect.getMetadata('design:returntype', target.prototype, method),
        ).toBe(Object);
      }
    });
    jest.dontMock('./program.service');
    jest.dontMock('./flight.service');
    jest.dontMock('./program-template.service');
    jest.dontMock('rxjs');
    jest.dontMock('@nestjs/common');
  });
});
