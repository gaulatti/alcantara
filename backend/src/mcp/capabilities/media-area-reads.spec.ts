/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the services are exercised through loosely typed fakes. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetsController } from '../../media-assets/media-assets.controller';
import { MediaController } from '../../media/media.controller';
import { RadioController } from '../../radio/radio.controller';
import { SongsController } from '../../songs/songs.controller';
import {
  asRest,
  principalWith,
  rebuilt,
  specNamed,
} from './capabilities.testing';
import {
  asset,
  assetsPage,
  coverage,
  decisions,
  exportOf,
  label,
  labelsPage,
  media,
  mediaPage,
  song,
  songsPage,
} from './media-area.testing';
import { MediaAssetsMcpTools } from './media-assets';
import { MediaMcpTools } from './media';
import { SimilarityMcpTools } from './similarity';
import { SongsMcpTools } from './songs';

// One set of fake services behind both the real controller and the capability:
// what the console is told is what the capability returns, with the user text
// under `untrusted` (the projection of radio_similarity_export is its page).

const services = {
  songs: { findAll: jest.fn(), findOne: jest.fn() },
  media: { findAll: jest.fn(), findOne: jest.fn() },
  assets: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findLabels: jest.fn(),
    findLabel: jest.fn(),
  },
  similarity: {
    getCoverage: jest.fn(),
    listDecisions: jest.fn(),
    exportSongs: jest.fn(),
  },
};

const grants = ['alcantara:access', 'alcantara:media:manage'];
const authorization = { permissions: grants };
const request = { user: { authorization } };
const ctx = {
  principal: principalWith(...(grants as never[])),
};

const controllers = {
  songs: new SongsController(services.songs as never),
  media: new MediaController(services.media as never),
  assets: new MediaAssetsController(services.assets as never),
  radio: new RadioController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    services.similarity as never,
  ),
};
const specs = [
  ...new SongsMcpTools(services.songs as never, {} as never).specs(),
  ...new MediaMcpTools(
    services.media as never,
    {} as never,
    { teamId: 7 } as never,
  ).specs(),
  ...new MediaAssetsMcpTools(services.assets as never, {} as never).specs(),
  ...new SimilarityMcpTools(services.similarity as never).specs(),
];
const run = async (name: string, args: Record<string, unknown>) =>
  (await specNamed(specs, name).run(args, ctx)).result;

beforeEach(() => {
  jest.clearAllMocks();
  services.songs.findAll.mockResolvedValue(songsPage);
  services.songs.findOne.mockResolvedValue(song);
  services.media.findAll.mockResolvedValue(mediaPage);
  services.media.findOne.mockResolvedValue(media);
  services.assets.findAll.mockResolvedValue(assetsPage);
  services.assets.findOne.mockResolvedValue(asset);
  services.assets.findLabels.mockResolvedValue(labelsPage);
  services.assets.findLabel.mockResolvedValue(label);
  services.similarity.getCoverage.mockResolvedValue(coverage);
  services.similarity.listDecisions.mockResolvedValue(decisions);
  services.similarity.exportSongs.mockResolvedValue(exportOf(3));
});

const MEDIA_TEAM = { user: { authorization: { teamId: 7 } } };

describe('song reads return what the controller returns', () => {
  it('song_find_all, with the console defaults and the filters it passes on', async () => {
    const result = await run('song_find_all', {});
    expect(rebuilt(result)).toEqual(asRest(await controllers.songs.findAll()));
    expect(result).toMatchObject({
      data: [
        {
          id: 7,
          untrusted: { artist: expect.stringContaining('ignore previous') },
        },
      ],
    });
    expect(services.songs.findAll).toHaveBeenNthCalledWith(1, {
      search: undefined,
      enabled: undefined,
      sortBy: undefined,
      sortOrder: undefined,
      page: 1,
      limit: 50,
      programId: undefined,
    });
    expect(services.songs.findAll).toHaveBeenNthCalledWith(
      2,
      services.songs.findAll.mock.calls[0][0],
    );
    await run('song_find_all', {
      search: 'ant',
      enabled: false,
      sort_by: 'title',
      sort_order: 'asc',
      page: 2,
      limit: 5,
      program_id: 'news',
    });
    expect(services.songs.findAll).toHaveBeenLastCalledWith({
      search: 'ant',
      enabled: false,
      sortBy: 'title',
      sortOrder: 'asc',
      page: 2,
      limit: 5,
      programId: 'news',
    });
    await controllers.songs.findAll(
      'ant',
      'false',
      'title',
      'asc',
      '2',
      '5',
      'news',
    );
    expect(services.songs.findAll).toHaveBeenLastCalledWith(
      services.songs.findAll.mock.calls[2][0],
    );
  });

  it('song_find_one', async () => {
    const result = await run('song_find_one', { song_id: 7 });
    expect(rebuilt(result)).toEqual(
      asRest(await controllers.songs.findOne('7')),
    );
    expect(result).toMatchObject({
      untrusted: { audioUrl: song.audioUrl },
      intro: { instant: { untrusted: { name: 'Station id' } } },
    });
    await run('song_find_one', { song_id: 7, program_id: 'news' });
    expect(services.songs.findOne).toHaveBeenLastCalledWith(7, 'news');
  });
});

describe('media reads', () => {
  it('media_find_all and media_find_one', async () => {
    expect(rebuilt(await run('media_find_all', {}))).toEqual(
      asRest(await controllers.media.findAll(MEDIA_TEAM)),
    );
    expect(services.media.findAll).toHaveBeenNthCalledWith(
      1,
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 50,
      },
      7,
    );
    const one = await run('media_find_one', { media_id: 11 });
    expect(rebuilt(one)).toEqual(
      asRest(await controllers.media.findOne('11', MEDIA_TEAM)),
    );
    expect(one).toMatchObject({
      id: 11,
      untrusted: { name: media.name, imageUrl: media.imageUrl },
    });
  });
});

describe('media asset and label reads', () => {
  it('hand the service the caller permissions, as the console guard does', async () => {
    expect(rebuilt(await run('media_asset_find_all', {}))).toEqual(
      asRest(await controllers.assets.findAll(request)),
    );
    expect(services.assets.findAll).toHaveBeenNthCalledWith(
      1,
      {
        search: undefined,
        mediaType: undefined,
        capability: undefined,
        labelId: undefined,
        page: 1,
        limit: 50,
      },
      authorization,
    );
    expect(services.assets.findAll).toHaveBeenNthCalledWith(
      2,
      services.assets.findAll.mock.calls[0][0],
      authorization,
    );
  });

  it('media_asset_find_one', async () => {
    const result = await run('media_asset_find_one', { asset_id: 'media:abc' });
    expect(rebuilt(result)).toEqual(
      asRest(await controllers.assets.findOne('media:abc', request)),
    );
    expect(result).toMatchObject({
      untrusted: { name: asset.name, sourceUrl: asset.sourceUrl },
    });
  });

  it('media_asset_find_labels and media_asset_find_label', async () => {
    expect(
      rebuilt(await run('media_asset_find_labels', { search: 'amb' })),
    ).toEqual(asRest(await controllers.assets.findLabels(request, 'amb')));
    const one = await run('media_asset_find_label', { label_id: 'label-1' });
    expect(rebuilt(one)).toEqual(
      asRest(await controllers.assets.findLabel('label-1', request)),
    );
    expect(one).toMatchObject({
      id: 'label-1',
      untrusted: { name: 'Ambience' },
    });
  });

  it('answers forbidden where the service refuses and not_found where it finds nothing', async () => {
    services.assets.findOne.mockRejectedValue(
      new NotFoundException('Media asset not found'),
    );
    await expect(
      run('media_asset_find_one', { asset_id: 'media:none' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    services.assets.findLabel.mockRejectedValue(new ForbiddenException());
    await expect(
      run('media_asset_find_label', { label_id: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('similarity reads', () => {
  it('radio_similarity_coverage and radio_similarity_decisions', async () => {
    expect(
      rebuilt(await run('radio_similarity_coverage', { program_id: 'main' })),
    ).toEqual(asRest(await controllers.radio.similarityCoverage('main')));
    const result = await run('radio_similarity_decisions', {
      program_id: 'main',
    });
    expect(rebuilt(result)).toEqual(
      asRest(await controllers.radio.similarityDecisions('main')),
    );
    expect(services.similarity.listDecisions).toHaveBeenNthCalledWith(
      1,
      'main',
      50,
    );
    expect(services.similarity.listDecisions).toHaveBeenNthCalledWith(
      2,
      'main',
      50,
    );
    expect(result).toMatchObject([
      { current: { untrusted: { artist: 'The Band', title: 'Anthem' } } },
    ]);
  });

  it('radio_similarity_export is the controller answer, paged', async () => {
    const whole = asRest(
      await controllers.radio.similarityExport('main', 'catalog', 'true'),
    ) as ReturnType<typeof exportOf>;
    expect(services.similarity.exportSongs).toHaveBeenLastCalledWith(
      'main',
      'catalog',
      true,
    );
    const page = (await run('radio_similarity_export', {
      program_id: 'main',
      scope: 'catalog',
      missing_only: true,
    })) as Record<string, unknown>;
    expect(services.similarity.exportSongs).toHaveBeenLastCalledWith(
      'main',
      'catalog',
      true,
    );
    expect(rebuilt(page)).toEqual({ ...whole, total: 3, offset: 0 });

    services.similarity.exportSongs.mockResolvedValue(exportOf(1200));
    const second = (await run('radio_similarity_export', {
      program_id: 'main',
      scope: 'sequence',
      offset: 200,
      limit: 2,
    })) as { total: number; offset: number; untrusted?: unknown };
    expect(second.total).toBe(1200);
    expect(second.offset).toBe(200);
    expect(JSON.stringify(second)).toContain('Artist 201');
    expect(JSON.stringify(second)).not.toContain('Artist 203');
    const first = (await run('radio_similarity_export', {
      program_id: 'main',
      scope: 'sequence',
    })) as { untrusted: { songs?: unknown } };
    expect(JSON.stringify(first)).toContain('Artist 200');
    expect(JSON.stringify(first)).not.toContain('Artist 201');
  });

  it('refuses an export of an unknown program as invalid', async () => {
    services.similarity.exportSongs.mockRejectedValue(
      new BadRequestException('Program not found'),
    );
    await expect(
      run('radio_similarity_export', { program_id: 'nope', scope: 'catalog' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('every read', () => {
  it('withholds an answer that carries a signed link', async () => {
    services.songs.findOne.mockResolvedValue({
      ...song,
      note: 'https://s3.example/a?X-Amz-Signature=abc',
    });
    await expect(run('song_find_one', { song_id: 7 })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
