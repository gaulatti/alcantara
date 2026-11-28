import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { RendererWriteGuard } from '../renderer-keys/renderer-write.guard';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PompeiiService } from '../auth/pompeii.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { RendererAuthService } from '../renderer-keys/renderer-auth.service';
import { FlightService } from './flight.service';
import { ProgramTemplateService } from './program-template.service';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';

// The public program routes and stream over HTTP, through the real controller and program service (gaulatti/alcantara#25):
// a program with no template manifest sends only what the on-air pages read, and a templated one keeps its own
// projection. Every value below that must not leave is marked HIDDEN; all values are fictional, built here.
const HIDDEN = 'HIDDEN-fictional-field';

function scene(id: number) {
  return {
    id,
    name: `${HIDDEN}-scene-name`,
    teamId: 7,
    layoutId: 3,
    chyronText: 'On air',
    metadata: { headline: 'Kept whole', nested: { colour: 'red' } },
    layout: { id: 3, name: `${HIDDEN}-layout`, componentType: 'lower-third,clock', settings: `${HIDDEN}-settings` },
  };
}

const leaf = {
  id: 'leaf-1',
  kind: 'preset',
  songId: 991,
  highRotation: true,
  artist: 'Artist',
  title: 'Title',
  coverUrl: 'https://cdn.example.test/cover.jpg',
  audioUrl: 'https://cdn.example.test/song.mp3',
  durationMs: 180_000,
  earoneSongId: 'e-1',
  earoneRank: '3',
  earoneSpins: '120',
  operatorNote: `${HIDDEN}-leaf-note`,
};

function row(programId: string, templateManifest: unknown) {
  return {
    id: 1,
    programId,
    type: 'tv',
    teamId: 7,
    templateManifest,
    activeSceneId: 11,
    stagedSceneId: 12,
    fadeToBlack: true,
    activeScene: scene(11),
    scenes: [
      { sceneId: 11, position: 0, scene: scene(11) },
      { sceneId: 12, position: 1, scene: scene(12) },
    ],
    mediaGroups: [{ mediaGroupId: 1, mediaGroup: { name: `${HIDDEN}-media-group` } }],
    stingers: [
      {
        id: 4,
        programStateId: 1,
        stingerId: 9,
        position: 0,
        stinger: { id: 9, name: 'Wipe', videoUrl: 'https://cdn.example.test/wipe.webm', cutPointMs: 900, assetId: `${HIDDEN}-asset`, teamId: 7, enabled: true },
      },
    ],
    flightSequences: [{ id: 1, name: `${HIDDEN}-flight` }],
    songQueue: [{ id: 'q1', title: `${HIDDEN}-queued-song` }],
    songSequence: {
      mode: 'autoplay',
      activeItemId: 'leaf-1',
      intervalMs: 0,
      loop: true,
      startedAt: 1_700_000_000_000,
      operatorNote: `${HIDDEN}-sequence-note`,
      items: [leaf, { id: 'group', kind: 'sequence', label: 'Group', sequence: { mode: 'manual', items: [{ ...leaf, id: 'leaf-2' }], activeItemId: null, intervalMs: 0, loop: false, startedAt: 0 } }],
    },
    audioMixer: null,
    operatorNotes: `${HIDDEN}-operator-notes`,
  };
}

describe('public program routes and stream, bounded (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let service: ProgramService;
  const rows = new Map<string, unknown>([
    ['station', row('station', null)],
    [
      'templated',
      row('templated', {
        kind: 'alcantara.program-template',
        contractVersion: 1,
        entrypointUrl: 'https://cdn.example.test/t/index.js',
        capabilities: [],
        control: { signals: ['scene_change'] },
      }),
    ],
  ]);

  beforeAll(async () => {
    const prisma = {
      programState: {
        findUnique: jest.fn(async ({ where }: { where: { programId: string } }) => rows.get(where.programId) ?? null),
      },
    };
    service = new ProgramService(prisma as never, {} as never, {} as never, undefined, undefined, noRecorder());
    const moduleRef = await Test.createTestingModule({
      controllers: [ProgramController],
      providers: [
        // The real service's public methods; Nest would otherwise run its module hooks, which need the radio.
        {
          provide: ProgramService,
          useValue: {
            getPublicState: service.getPublicState.bind(service),
            getPublicProgramAudioBus: service.getPublicProgramAudioBus.bind(service),
            getEventStream: service.getEventStream.bind(service),
          },
        },
        { provide: FlightService, useValue: {} },
        { provide: ProgramTemplateService, useValue: {} },
        { provide: RendererAuthService, useValue: {} },
        { provide: PompeiiService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  /** The first `count` events of a program's public stream, after `then` runs once the stream is open. */
  async function events(programId: string, count: number, then: () => void = () => undefined) {
    const controller = new AbortController();
    const response = await fetch(`${origin}/program/${programId}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];
    let buffer = '';
    let opened = false;
    while (received.length < count) {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) received.push(data.slice('data: '.length));
      }
      if (!opened && received.length > 0) {
        opened = true;
        then();
      }
    }
    controller.abort();
    return received.map((text) => ({ text, json: JSON.parse(text) as Record<string, unknown> }));
  }

  const expectedState = {
    activeSceneId: 11,
    fadeToBlack: true,
    stingers: [{ stingerId: 9, stinger: { name: 'Wipe', videoUrl: 'https://cdn.example.test/wipe.webm', cutPointMs: 900 } }],
    activeScene: {
      id: 11,
      layout: { componentType: 'lower-third,clock' },
      chyronText: 'On air',
      metadata: { headline: 'Kept whole', nested: { colour: 'red' } },
    },
    stagedScene: {
      id: 12,
      layout: { componentType: 'lower-third,clock' },
      chyronText: 'On air',
      metadata: { headline: 'Kept whole', nested: { colour: 'red' } },
    },
  };

  it('sends the on-air fields of the state and nothing else, with no manifest', async () => {
    const response = await fetch(`${origin}/program/station/state`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ...expectedState, version: expect.any(Number) });
    expect(text).not.toContain(HIDDEN);
  });

  it('keeps the template projection for a templated program, which sends no hidden field either', async () => {
    const text = await (await fetch(`${origin}/program/templated/state`)).text();
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: expect.anything(), activeSceneId: 11 });
    expect(text).not.toContain('operatorNotes');
    expect(text).not.toContain(`${HIDDEN}-media-group`);
    expect(text).not.toContain(`${HIDDEN}-queued-song`);
  });

  it('sends the mixer and the song sequence cut to its playable leaves, with no queue', async () => {
    const response = await fetch(`${origin}/program/station/audio-bus`);
    const text = await response.text();
    const bus = JSON.parse(text) as { songSequence: { items: Array<Record<string, unknown>> } };
    expect(Object.keys(bus).sort()).toEqual(['mixerSettings', 'sequenceVersion', 'shuffleKeepsRows', 'songSequence']);
    expect(bus.songSequence).toMatchObject({ mode: 'autoplay', activeItemId: 'leaf-1', loop: true });
    expect(bus.songSequence.items[0]).toEqual({
      id: 'leaf-1',
      kind: 'preset',
      artist: 'Artist',
      title: 'Title',
      coverUrl: 'https://cdn.example.test/cover.jpg',
      audioUrl: 'https://cdn.example.test/song.mp3',
      durationMs: 180_000,
      earoneSongId: 'e-1',
      earoneRank: '3',
      earoneSpins: '120',
    });
    expect(bus.songSequence.items[1]).toMatchObject({ id: 'group', kind: 'sequence', label: 'Group', sequence: { items: [{ id: 'leaf-2', coverUrl: 'https://cdn.example.test/cover.jpg' }] } });
    expect(text).not.toContain(HIDDEN);
    expect(text).not.toContain('songId');
    expect(text).not.toContain('highRotation');
  });

  it('sends the same bounded state on the stream, on its snapshot and on every state-bearing event', async () => {
    // As the emitters send it: the stored row with its staged scene resolved.
    const full = { ...row('station', null), stagedScene: scene(12) };
    const received = await events('station', 6, () => {
      service.broadcastUpdate('station', { type: 'fade_to_black', programId: 'station', active: true, state: full });
      service.broadcastUpdate('station', { type: 'scene_staged', programId: 'station', stagedSceneId: 12, scene: scene(12) });
      service.broadcastUpdate('station', { type: 'scene_change', programId: 'station', state: full });
      service.broadcastUpdate('station', {
        type: 'audio_bus_update',
        programId: 'station',
        settings: { songSequence: full.songSequence, songQueue: full.songQueue, mixerSettings: { master: 1 } },
      });
      service.broadcastUpdate('station', { type: 'song_queue_update', programId: 'station', songQueue: full.songQueue, songSequence: full.songSequence });
    });
    const [snapshot, fade, staged, change, bus, queue] = received.map((event) => event.json);
    expect(snapshot).toMatchObject({ type: 'program_state_snapshot', state: expectedState });
    expect(fade).toMatchObject({ type: 'fade_to_black', active: true, state: expectedState });
    expect(staged).toMatchObject({ type: 'scene_staged', stagedSceneId: 12, scene: expectedState.stagedScene });
    expect(change).toMatchObject({ type: 'scene_change', state: expectedState });
    expect(bus).toMatchObject({ type: 'audio_bus_update', settings: { mixerSettings: { master: 1 } } });
    expect(bus.settings).not.toHaveProperty('songQueue');
    expect(queue).not.toHaveProperty('songQueue');
    expect(queue).toMatchObject({ songSequence: { activeItemId: 'leaf-1' } });
    for (const event of received) expect(event.text).not.toContain(HIDDEN);
  });

  it('versions the public contract on the snapshot; a templated program keeps its schema version', async () => {
    const [station] = await events('station', 1);
    expect(station.json).toMatchObject({ type: 'program_state_snapshot', contractVersion: 1 });
    const [templated] = await events('templated', 1);
    expect(templated.json).toMatchObject({ type: 'program_state_snapshot', schemaVersion: expect.anything() });
    expect(templated.json).not.toHaveProperty('contractVersion');
  });

  it('sends no operator identity on the public stream; the control stream keeps it', async () => {
    const actor = { actorPrincipalId: 'principal-secret-id', actorVia: 'mcp', actorClient: 'console' };
    const emit = () =>
      service.broadcastUpdate('station', { type: 'song_off_air', programId: 'station', triggeredAt: 'now', ...actor });
    const [, publicEvent] = await events('station', 2, emit);
    expect(publicEvent.json).toMatchObject({ type: 'song_off_air', triggeredAt: 'now' });
    for (const field of Object.keys(actor)) expect(publicEvent.json).not.toHaveProperty(field);
    expect(publicEvent.text).not.toContain('principal-secret-id');

    const controller = new AbortController();
    const response = await fetch(`${origin}/program/station/control/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let emitted = false;
    while (!buffer.includes('song_off_air')) {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      if (!emitted && buffer.includes('program_state_snapshot')) {
        emitted = true;
        emit();
      }
    }
    controller.abort();
    expect(buffer).toContain('principal-secret-id');
  });
});

describe('the public program surface takes no command (gaulatti/alcantara#25)', () => {
  it('opens only reads to a caller with no sign-in, besides the renderer page\'s own writes behind the renderer guard', () => {
    const prototype = ProgramController.prototype as unknown as Record<string, unknown>;
    const handler = (name: string) => prototype[name] as object;
    const publicRoutes = Object.getOwnPropertyNames(prototype)
      .filter((name) => typeof prototype[name] === 'function' && name !== 'constructor')
      .filter((name) => Reflect.getMetadata(IS_PUBLIC_KEY, handler(name)) === true);
    const reads = (name: string) =>
      Reflect.getMetadata(METHOD_METADATA, handler(name)) === RequestMethod.GET ||
      Reflect.getMetadata(SSE_METADATA, handler(name)) === true;
    const writes = publicRoutes.filter((name) => !reads(name));
    expect(publicRoutes.length).toBeGreaterThan(writes.length);
    // The renderer page's meter and countdown reports, and nothing else: each is judged by the renderer guard.
    expect(writes.sort()).toEqual(['completeSceneCountdownById', 'updateProgramAudioMeterById']);
    for (const name of writes) {
      expect(Reflect.getMetadata('rendererWriteEndpoint', handler(name))).toBeDefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toContain(RendererWriteGuard);
    }
  });
});
