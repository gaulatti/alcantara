import { ProgramService } from './program.service';

function fixture() {
  const state = { id: 1, programId: 'news', type: 'radio' };
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue(state),
      upsert: jest.fn().mockResolvedValue(state),
    },
  };
  const engine = { setBroadcastHandler: jest.fn() };
  const service = new ProgramService(
    prisma,
    {} as any,
    engine as any,
    undefined,
    { observe: jest.fn() } as any,
  );
  const events: any[] = [];
  service.addEventListener((event) => events.push(event.data));
  return { service, prisma, engine, events };
}

describe('ProgramService optional playout feedback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps song meters correct when the audio producer has no intro channel', async () => {
    const f = fixture();
    await f.service.onModuleInit();
    const levels = {
      song: { rms: 0.4, peak: 0.7 },
      instant: { rms: 0.1, peak: 0.2 },
      output: { rms: 0.5, peak: 0.8 },
    };
    const dispatch = f.engine.setBroadcastHandler.mock.calls[0][0];
    dispatch({
      type: 'audio_levels',
      programId: 'news',
      levels,
      sampledAt: '2026-01-01T12:00:00.000Z',
    });
    const result = await f.service.getProgramAudioMeter('news');
    expect(result.song).toEqual({ vu: 0.4, peak: 0.7, peakHold: 0.7 });
    expect(result.main).toEqual({ vu: 0.5, peak: 0.8, peakHold: 0.8 });
    expect(f.events).toEqual([
      expect.objectContaining({ type: 'palazzo_audio_levels', levels }),
      expect.objectContaining({ type: 'audio_meter_update', version: 1 }),
    ]);
  });

  it('makes a stop with no prior scene instant a coherent, versioned idle state', async () => {
    const f = fixture();
    const result = await f.service.stopProgramSceneInstant(' news ', 1500);
    expect(result).toMatchObject({
      programId: 'news',
      sceneId: null,
      instantId: null,
      mediaAssetId: null,
      instant: null,
      isPlaying: false,
      startedAt: null,
      version: 1,
    });
    expect(f.events).toEqual([
      expect.objectContaining({
        type: 'scene_instant_stop',
        sceneId: null,
        instantId: null,
        mediaAssetId: null,
        fadeMs: 1500,
        version: 1,
      }),
    ]);
    expect(await f.service.getProgramSceneInstantPlayback('news')).toEqual(
      result,
    );
  });

  it('does not deliver a successful initial snapshot after its SSE subscriber has disconnected', async () => {
    const f = fixture();
    let finish!: (state: any) => void;
    f.prisma.programState.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const next = jest.fn();
    const subscription = f.service.getEventStream('news').subscribe({ next });
    subscription.unsubscribe();
    finish({ id: 1, programId: 'news', scenes: [], stagedSceneId: null });
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
  });
});
