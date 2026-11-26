/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the services are exercised through loosely typed fakes. */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MediaAssetsController } from '../../media-assets/media-assets.controller';
import { MediaController } from '../../media/media.controller';
import { RadioController } from '../../radio/radio.controller';
import { SongsController } from '../../songs/songs.controller';
import {
  asRest,
  fakeServices,
  principalWith,
  rebuilt,
  specNamed,
} from './capabilities.testing';
import { asset, label, media, song } from './media-area.testing';
import { MediaAssetsMcpTools } from './media-assets';
import { MediaMcpTools } from './media';
import { SimilarityMcpTools } from './similarity';
import { SongsMcpTools } from './songs';

// W rows: the capability reaches the service with what the controller would
// send for the same input and answers what the controller answers (the label
// writes answer a documented projection: ids instead of every asset).

const grants = ['alcantara:access', 'alcantara:scene:manage'];
const authorization = { permissions: grants, teamId: 7 };
const request = { user: { authorization } };
const ctx = { principal: principalWith(...(grants as never[])) };

const upload = {
  schema: 1,
  model: { name: 'm', version: '1', license: 'x' },
  windowSeconds: 30,
  songs: [{ songId: 7 }, { songId: 8 }],
};

const SONG_TEAM = { user: { authorization: { teamId: 7 } } };
const MEDIA_TEAM = { user: { authorization: { teamId: 7 } } };

function build() {
  const programs = fakeServices().programs;
  const services = {
    songs: {
      findOne: jest.fn().mockResolvedValue(song),
      create: jest.fn().mockResolvedValue(song),
      update: jest.fn().mockResolvedValue(song),
    },
    media: {
      findOne: jest.fn().mockResolvedValue(media),
      create: jest.fn().mockResolvedValue(media),
      update: jest.fn().mockResolvedValue(media),
    },
    assets: {
      findOne: jest.fn().mockResolvedValue(asset),
      findLabel: jest.fn().mockResolvedValue(label),
      createBackgroundAudio: jest.fn().mockResolvedValue(asset),
      replaceAssetLabels: jest.fn().mockResolvedValue(asset),
      createLabel: jest.fn().mockResolvedValue(label),
      updateLabel: jest.fn().mockResolvedValue(label),
      replaceLabelAssets: jest.fn().mockResolvedValue(label),
    },
    similarity: {
      storeEmbeddings: jest.fn().mockResolvedValue({
        results: [{ songId: 7, status: 'stored' }],
      }),
    },
  };
  const specs = [
    ...new SongsMcpTools(
      services.songs as never,
      programs as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new MediaMcpTools(
      services.media as never,
      programs as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new MediaAssetsMcpTools(
      services.assets as never,
      programs as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new SimilarityMcpTools(services.similarity as never).specs(),
  ];
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
  const run = async (name: string, args: Record<string, unknown>) =>
    (await specNamed(specs, name).run(args, ctx)).result;
  const plan = (name: string, args: Record<string, unknown>) =>
    specNamed(specs, name).dryRun!(args, ctx);
  return { services, controllers, run, plan, programs };
}

describe('song writes', () => {
  it('song_create sends the service what the controller sends and answers the same', async () => {
    const { services, controllers, run, plan } = build();
    const body = {
      artist: 'A',
      title: 'T',
      audioUrl: 'https://cdn.example/a.mp3',
      coverUrl: null,
      durationMs: 1000,
      externalChartId: 5,
      externalChartRank: '2',
      externalChartSpins: '9',
      externalChartProvider: 'p',
      enabled: false,
      programId: 'news',
      introInstantId: 8,
    };
    const expected = asRest(await controllers.songs.create(body, SONG_TEAM));
    const result = await run('song_create', {
      artist: 'A',
      title: 'T',
      audio_url: 'https://cdn.example/a.mp3',
      cover_url: null,
      duration_ms: 1000,
      external_chart_id: 5,
      external_chart_rank: '2',
      external_chart_spins: '9',
      external_chart_provider: 'p',
      enabled: false,
      program_id: 'news',
      intro_instant_id: 8,
    });
    expect(services.songs.create.mock.calls[1]).toEqual(
      services.songs.create.mock.calls[0],
    );
    expect(rebuilt(result)).toEqual(expected);
    expect(result).toMatchObject({ untrusted: { artist: song.artist } });
    expect(
      await plan('song_create', { audio_url: 'https://cdn.example/a.mp3' }),
    ).toMatchObject({ onAir: false, recoverable: true });
  });

  it('song_update leaves out what was not given, and flags a song that is playing', async () => {
    const { services, controllers, run, plan, programs } = build();
    await controllers.songs.update(
      '7',
      { title: 'New', introInstantId: null },
      SONG_TEAM,
    );
    const result = await run('song_update', {
      song_id: 7,
      title: 'New',
      intro_instant_id: null,
    });
    expect(services.songs.update.mock.calls[1]).toEqual(
      services.songs.update.mock.calls[0],
    );
    expect(rebuilt(result)).toEqual(asRest(song));
    expect((await plan('song_update', { song_id: 7 })).onAir).toBe(false);
    programs.getProgramSongPlayback.mockResolvedValue({
      isPlaying: true,
      audioUrl: song.audioUrl,
    });
    const live = await plan('song_update', { song_id: 7, enabled: false });
    expect(live.onAir).toBe(true);
    expect(live.summary).toMatch(/playing on 1 program/);
  });

  it('reports the service refusals as MCP codes', async () => {
    const { services, run } = build();
    services.songs.create.mockRejectedValue(
      new BadRequestException('artist or title is required'),
    );
    await expect(
      run('song_create', { audio_url: 'https://cdn.example/a.mp3' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('media writes', () => {
  it('media_create and media_update', async () => {
    const { services, controllers, run, plan } = build();
    const created = asRest(
      await controllers.media.create(
        {
          name: 'N',
          imageUrl: 'https://x/y.png',
        },
        MEDIA_TEAM,
      ),
    );
    expect(
      rebuilt(
        await run('media_create', { name: 'N', image_url: 'https://x/y.png' }),
      ),
    ).toEqual(created);
    expect(services.media.create.mock.calls[1]).toEqual(
      services.media.create.mock.calls[0],
    );
    await controllers.media.update('11', { name: 'M' }, MEDIA_TEAM);
    const updated = await run('media_update', { media_id: 11, name: 'M' });
    expect(services.media.update.mock.calls[1]).toEqual(
      services.media.update.mock.calls[0],
    );
    expect(rebuilt(updated)).toEqual(asRest(media));
    expect((await plan('media_update', { media_id: 11 })).onAir).toBe(false);
  });
});

describe('media asset and label writes', () => {
  it('create the background audio with the caller permissions', async () => {
    const { services, controllers, run } = build();
    await controllers.assets.createBackgroundAudio(
      { name: 'N', sourceUrl: 'https://x/a.mp3', defaultVolume: 0.5 },
      request,
    );
    const result = await run('media_asset_create_background_audio', {
      name: 'N',
      source_url: 'https://x/a.mp3',
      default_volume: 0.5,
    });
    expect(services.assets.createBackgroundAudio.mock.calls[1]).toEqual(
      services.assets.createBackgroundAudio.mock.calls[0],
    );
    expect(rebuilt(result)).toEqual(asRest(asset));
  });

  it('replace the labels of an asset', async () => {
    const { services, controllers, run, plan } = build();
    await controllers.assets.replaceAssetLabels(
      'media:abc',
      { labelIds: ['label-1'] },
      request,
    );
    const result = await run('media_asset_replace_asset_labels', {
      asset_id: 'media:abc',
      label_ids: ['label-1'],
    });
    expect(services.assets.replaceAssetLabels.mock.calls[1]).toEqual(
      services.assets.replaceAssetLabels.mock.calls[0],
    );
    expect(rebuilt(result)).toEqual(asRest(asset));
    expect(
      await plan('media_asset_replace_asset_labels', {
        asset_id: 'media:abc',
        label_ids: [],
      }),
    ).toMatchObject({ recoverable: true, onAir: false });
  });

  it('label writes answer ids instead of every asset', async () => {
    const { services, controllers, run } = build();
    const whole = asRest(
      await controllers.assets.createLabel(
        { name: 'Ambience', description: 'd' },
        request,
      ),
    ) as typeof label;
    const projected = (await run('media_asset_create_label', {
      name: 'Ambience',
      description: 'd',
    })) as Record<string, any>;
    expect(services.assets.createLabel.mock.calls[1]).toEqual(
      services.assets.createLabel.mock.calls[0],
    );
    expect(rebuilt(projected)).toEqual({
      id: whole.id,
      createdAt: whole.createdAt,
      updatedAt: whole.updatedAt,
      assetCount: whole.assetCount,
      assetIds: ['media:abc'],
      name: whole.name,
      description: whole.description,
    });
    expect(projected.untrusted.name).toBe('Ambience');
    expect(projected.assets).toBeUndefined();

    await controllers.assets.updateLabel('label-1', { name: 'B' }, request);
    await run('media_asset_update_label', { label_id: 'label-1', name: 'B' });
    expect(services.assets.updateLabel.mock.calls[1]).toEqual(
      services.assets.updateLabel.mock.calls[0],
    );

    await controllers.assets.replaceLabelAssets(
      'label-1',
      { assetIds: ['media:abc'] },
      request,
    );
    await run('media_asset_replace_label_assets', {
      label_id: 'label-1',
      asset_ids: ['media:abc'],
    });
    expect(services.assets.replaceLabelAssets.mock.calls[1]).toEqual(
      services.assets.replaceLabelAssets.mock.calls[0],
    );
  });

  it("passes the service's forbidden on as forbidden", async () => {
    const { services, run } = build();
    services.assets.createLabel.mockRejectedValue(new ForbiddenException());
    await expect(
      run('media_asset_create_label', { name: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('flags a label write that a scene on air names', async () => {
    const { programs, plan } = build();
    const live = {
      ...(await programs.listPrograms())[0],
      activeSceneId: 3,
    };
    live.scenes[0].scene.metadata = '{"slides":"label-1"}';
    programs.listPrograms.mockResolvedValue([live]);
    const dry = await plan('media_asset_replace_label_assets', {
      label_id: 'label-1',
      asset_ids: [],
    });
    expect(dry.onAir).toBe(true);
    expect(dry.summary).toMatch(/read by 1 program/);
  });
});

describe('radio_similarity_upload', () => {
  it('stores what the controller stores and answers the same', async () => {
    const { services, controllers, run, plan } = build();
    const expected = asRest(
      await controllers.radio.similarityUpload('main', upload),
    );
    const result = await run('radio_similarity_upload', {
      program_id: 'main',
      upload,
    });
    expect(services.similarity.storeEmbeddings.mock.calls[1]).toEqual([
      upload,
      'main',
    ]);
    expect(rebuilt(result)).toEqual(expected);
    expect(
      await plan('radio_similarity_upload', { program_id: 'main', upload }),
    ).toMatchObject({
      summary: expect.stringContaining('2 song(s)'),
      onAir: false,
    });
  });
});

describe('answers that carry a credential', () => {
  it('are withheld after the write', async () => {
    const { services, run } = build();
    services.media.update.mockResolvedValue({
      ...media,
      imageUrl: 'https://s3.example/a.png?X-Amz-Signature=abc',
    });
    await expect(
      run('media_update', { media_id: 11, name: 'x' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the dry run of every W capability', () => {
  it.each([
    [
      'song_create',
      { audio_url: 'https://cdn.example/a.mp3' },
      /Creates a song/,
    ],
    ['song_update', { song_id: 7, enabled: false }, /Updates song 7/],
    [
      'media_create',
      { name: 'N', image_url: 'https://x/y.png' },
      /Creates an image/,
    ],
    ['media_update', { media_id: 11, name: 'M' }, /Updates image 11/],
    [
      'media_asset_create_background_audio',
      { name: 'N', source_url: 'https://x/a.mp3' },
      /Creates a background audio asset/,
    ],
    [
      'media_asset_replace_asset_labels',
      { asset_id: 'media:abc', label_ids: ['label-1'] },
      /Replaces the 1 label\(s\) of asset media:abc with 1/,
    ],
    ['media_asset_create_label', { name: 'L' }, /Creates an empty media label/],
    [
      'media_asset_update_label',
      { label_id: 'label-1', name: 'L' },
      /Updates media label label-1\./,
    ],
    [
      'media_asset_replace_label_assets',
      { label_id: 'label-1', asset_ids: ['media:abc'] },
      /Replaces the 1 asset\(s\) of media label label-1 with 1/,
    ],
    [
      'radio_similarity_upload',
      { program_id: 'main', upload: { songs: 'x' } },
      /Stores the embeddings of 0 song/,
    ],
  ])('%s is a plan that changes nothing', async (name, args, words) => {
    const { services, plan } = build();
    const dry = await plan(name, args);
    expect(dry.summary).toMatch(words);
    expect(dry.onAir).toBe(false);
    expect(dry.recoverable).toBe(true);
    for (const service of Object.values(services))
      for (const [method, fn] of Object.entries(service))
        if (/^(create|update|remove|replace|store)/.test(method))
          expect(fn).not.toHaveBeenCalled();
  });
});

describe('a legacy slideshow label', () => {
  it('names the media group it mirrors in the plan of an update', async () => {
    const { services, plan } = build();
    services.assets.findLabel.mockResolvedValue({
      ...label,
      id: 'legacy-media-group:5',
    });
    const dry = await plan('media_asset_update_label', {
      label_id: 'legacy-media-group:5',
      name: 'L',
    });
    expect(dry.summary).toMatch(
      /Updates media label legacy-media-group:5 and the media group 5 it mirrors/,
    );
    const replace = await plan('media_asset_replace_label_assets', {
      label_id: 'legacy-media-group:5',
      asset_ids: [],
    });
    expect(replace.summary).toMatch(/rewriting the media group 5 it mirrors/);
  });
});

describe('plans for a target with unusual data', () => {
  it('names a scene whose settings are empty as no reader, and an asset with no capability', async () => {
    const { programs, services, plan } = build();
    const state = (await programs.listPrograms())[0] as any;
    state.scenes[0].scene.metadata = null;
    programs.listPrograms.mockResolvedValue([state]);
    services.assets.findOne.mockResolvedValue({ ...asset, capabilities: [] });
    const dry = await plan('media_asset_replace_asset_labels', {
      asset_id: 'media:abc',
      label_ids: [],
    });
    expect(dry.summary).toMatch(/Replaces the 1 label/);
  });
});
