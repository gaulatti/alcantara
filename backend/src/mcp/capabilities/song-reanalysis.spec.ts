import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { SongReanalysisMcpTools } from './song-reanalysis';

const reanalysis = {
  onAir: jest.fn(
    async (ids: number[]) =>
      new Map(ids.map((id) => [id, id === 9 ? ['radio-1'] : []])),
  ),
  request: jest.fn(async () => ({ requested: 2, skipped: [] })),
};
const tools = new SongReanalysisMcpTools(reanalysis as never);
const spec = tools.specs()[0];
const ctx = {} as never;

beforeEach(() => jest.clearAllMocks());

describe('song_request_reanalysis (gaulatti/alcantara#235)', () => {
  it('is a tier W capability with song.manage', () => {
    expect(tools.specs()).toHaveLength(1);
    expect([spec.name, spec.tier, spec.permission]).toEqual([
      'song_request_reanalysis',
      'W',
      ALCANTARA_PERMISSIONS.song.manage,
    ]);
  });

  it('plans the batch in words, naming each song and which are on air, and changes nothing in a dry run', async () => {
    const dry = await spec.dryRun!({ song_ids: [4] }, ctx);
    expect(dry).toMatchObject({
      summary: expect.stringContaining('Queues 1 song(s)'),
      affects: [{ kind: 'song', id: '4', name: '4' }],
      recoverable: true,
      onAir: false,
    });
    expect((dry as { summary: string }).summary).toContain('On air now: none.');
    expect(reanalysis.request).not.toHaveBeenCalled();
  });

  it('lists a song that is on air per id in the plan and refuses it as on_air', async () => {
    const dry = await spec.dryRun!({ song_ids: [4, 9] }, ctx);
    expect((dry as { summary: string }).summary).toContain(
      'REFUSED (on_air): song 9 is on air on radio-1',
    );
    expect((dry as { summary: string }).summary).toContain(
      'On air now: song 9 on radio-1.',
    );
    expect((dry as { onAir: boolean }).onAir).toBe(true);
    await expect(spec.run({ song_ids: [4, 9] }, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    expect(reanalysis.request).not.toHaveBeenCalled();
  });

  it('queues the songs through the service when none is on air', async () => {
    await expect(spec.run({ song_ids: [4, 5] }, ctx)).resolves.toMatchObject({
      result: { requested: 2, skipped: [] },
      audit: { target: '4,5' },
    });
    expect(reanalysis.request).toHaveBeenCalledWith([4, 5], undefined);
  });

  it('names the rule in the plan and passes it on: previous is the way back that needs no deploy', async () => {
    const plan = (await spec.dryRun!(
      { song_ids: [4], rule: 'previous' },
      ctx,
    )) as { summary: string };
    expect(plan.summary).toContain('on rule previous');
    const dflt = (await spec.dryRun!({ song_ids: [4] }, ctx)) as {
      summary: string;
    };
    expect(dflt.summary).toContain('on rule C');
    await spec.run({ song_ids: [4], rule: 'previous' }, ctx);
    expect(reanalysis.request).toHaveBeenLastCalledWith([4], 'previous');
    expect(spec.shape.rule.safeParse('B').success).toBe(false);
    expect(spec.shape.rule.safeParse('previous').success).toBe(true);
    expect(spec.shape.rule.safeParse(undefined).success).toBe(true);
  });
});

describe('SongReanalysisMcpTools dependency metadata', () => {
  it('records Object for the constructor type of a dependency that is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../songs/song-reanalysis.service', () => ({
        SongReanalysisService: undefined,
        MAX_REANALYSIS_BATCH: 25,
        REANALYSIS_RULES: ['C', 'previous'],
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./song-reanalysis') as {
        SongReanalysisMcpTools: new (...args: never[]) => unknown;
      };
      const types = Reflect.getMetadata(
        'design:paramtypes',
        loaded.SongReanalysisMcpTools,
      ) as Array<{ name: string }>;
      expect(types.map((type) => type.name)).toEqual(['Object']);
    });
    jest.dontMock('../../songs/song-reanalysis.service');
  });
});
