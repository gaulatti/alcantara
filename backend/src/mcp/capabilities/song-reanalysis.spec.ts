import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { SongReanalysisMcpTools } from './song-reanalysis';

const songs = {
  requestReanalysis: jest.fn(async () => ({ requested: 2, skipped: [] })),
};
const tools = new SongReanalysisMcpTools(songs as never);
const spec = tools.specs()[0];
const ctx = {} as never;

describe('song_request_reanalysis (gaulatti/alcantara#235)', () => {
  it('is a tier W capability with song.manage', () => {
    expect(tools.specs()).toHaveLength(1);
    expect([spec.name, spec.tier, spec.permission]).toEqual([
      'song_request_reanalysis',
      'W',
      ALCANTARA_PERMISSIONS.song.manage,
    ]);
  });

  it('plans the batch in words, naming each song, and changes nothing in a dry run', async () => {
    const dry = await spec.dryRun!({ song_ids: [4, 9] }, ctx);
    expect(dry).toMatchObject({
      summary: expect.stringContaining('Queues 2 song(s)'),
      affects: [
        { kind: 'song', id: '4', name: '4' },
        { kind: 'song', id: '9', name: '9' },
      ],
      recoverable: true,
    });
    expect(songs.requestReanalysis).not.toHaveBeenCalled();
  });

  it('queues the songs through the service', async () => {
    await expect(spec.run({ song_ids: [4, 9] }, ctx)).resolves.toMatchObject({
      result: { requested: 2, skipped: [] },
      audit: { target: '4,9' },
    });
    expect(songs.requestReanalysis).toHaveBeenCalledWith([4, 9]);
  });
});

describe('SongReanalysisMcpTools dependency metadata', () => {
  it('records Object for the constructor type of a dependency that is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../songs/songs.service', () => ({
        SongsService: undefined,
        MAX_REANALYSIS_BATCH: 25,
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
    jest.dontMock('../../songs/songs.service');
  });
});
