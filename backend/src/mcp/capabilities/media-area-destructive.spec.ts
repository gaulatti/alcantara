/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the services are exercised through loosely typed fakes. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  fakeServices,
  principalWith,
  specNamed,
  stateOf,
} from './capabilities.testing';
import { asset, label, media, song } from './media-area.testing';
import { MediaAssetsMcpTools } from './media-assets';
import { MediaMcpTools } from './media';
import { SongsMcpTools } from './songs';

// Step 0 of every D row of gaulatti/alcantara#218: what the console does when
// the target is on air, queued or referenced, and what these capabilities do
// instead. The console deletes in every one of these cases (the services check
// only that the row exists); the capability refuses with on_air, and its dry
// run says what would be lost and that it cannot be recovered.

const ctx = { principal: principalWith('alcantara:access' as never) };
const leaf = {
  id: 'i1',
  kind: 'preset',
  songId: 7,
  artist: 'A',
  title: 'T',
  coverUrl: '',
  audioUrl: song.audioUrl,
};
const sequence = {
  mode: 'manual',
  items: [leaf],
  activeItemId: 'i1',
  intervalMs: 4000,
  loop: true,
  startedAt: 1,
};

function build() {
  const programs = fakeServices().programs;
  const services = {
    songs: {
      findOne: jest.fn().mockResolvedValue(song),
      remove: jest.fn().mockResolvedValue({ deletedSongId: 7 }),
    },
    media: {
      findOne: jest.fn().mockResolvedValue(media),
      remove: jest.fn().mockResolvedValue({ deletedMediaId: 11 }),
    },
    assets: {
      findOne: jest.fn().mockResolvedValue(asset),
      findLabel: jest.fn().mockResolvedValue(label),
      removeStandaloneAsset: jest
        .fn()
        .mockResolvedValue({ deletedMediaAssetId: 'media:abc' }),
      removeLabel: jest
        .fn()
        .mockResolvedValue({ deletedMediaLabelId: 'label-1' }),
    },
  };
  const specs = [
    ...new SongsMcpTools(services.songs as never, programs as never).specs(),
    ...new MediaMcpTools(
      services.media as never,
      programs as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new MediaAssetsMcpTools(
      services.assets as never,
      programs as never,
    ).specs(),
  ];
  const live = (overrides: Record<string, unknown>) =>
    programs.listPrograms.mockResolvedValue([stateOf(overrides)]);
  return {
    programs,
    services,
    spec: (name: string) => specNamed(specs, name),
    live,
  };
}

async function refused(
  name: string,
  args: Record<string, unknown>,
  prepare: (b: ReturnType<typeof build>) => void,
  service: (b: ReturnType<typeof build>) => jest.Mock,
  words: RegExp,
) {
  const b = build();
  prepare(b);
  const plan = await b.spec(name).dryRun!(args, ctx);
  expect(plan.onAir).toBe(true);
  expect(plan.recoverable).toBe(false);
  expect(plan.summary).toMatch(/^REFUSED \(on_air\): /);
  expect(plan.summary).toMatch(words);
  await expect(b.spec(name).run(args, ctx)).rejects.toMatchObject({
    code: 'on_air',
    message: expect.stringMatching(words),
  });
  expect(service(b)).not.toHaveBeenCalled();
}

describe('song_remove', () => {
  const args = { song_id: 7 };
  it('is refused while a program is playing the song', () =>
    refused(
      'song_remove',
      args,
      (b) =>
        b.programs.getProgramSongPlayback.mockResolvedValue({
          isPlaying: true,
          audioUrl: ` ${song.audioUrl} `,
        }),
      (b) => b.services.songs.remove,
      /song 7 is playing on main/,
    ));

  it('is refused while it is queued, by a sequence item or from the catalog', async () => {
    const queued = (itemId: string) => (b: ReturnType<typeof build>) =>
      b.live({
        songQueue: [{ id: 'e1', itemId, enqueuedAt: 5 }],
      });
    await refused(
      'song_remove',
      args,
      (b) =>
        b.live({
          songSequence: {
            ...sequence,
            items: [{ ...leaf, id: 'i0', songId: 99 }, leaf],
          },
          songQueue: [{ id: 'e1', itemId: 'i1', enqueuedAt: 5 }],
        }),
      (b) => b.services.songs.remove,
      /song 7 is queued on main/,
    );
    await refused(
      'song_remove',
      args,
      queued('catalog:7'),
      (b) => b.services.songs.remove,
      /song 7 is queued on main/,
    );
  });

  it('is refused while a program lists it in its song sequence', () =>
    refused(
      'song_remove',
      args,
      (b) => b.live({ songSequence: sequence }),
      (b) => b.services.songs.remove,
      /song 7 is in the song sequence of main/,
    ));

  it('says what is lost, as unrecoverable, and runs for an idle song', async () => {
    const { services, spec, live } = build();
    live({ songSequence: { ...sequence, items: [{ ...leaf, songId: 5 }] } });
    const plan = await spec('song_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(
      /media asset, cover link, chart identity, intro assignment and embeddings/,
    );
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(plan.summary).toMatch(/The console deletes without looking/);
    expect(await spec('song_remove').confirmTarget!(args, ctx)).toEqual({
      id: '7',
      name: `${song.artist} - ${song.title}`,
    });
    await expect(spec('song_remove').run(args, ctx)).resolves.toMatchObject({
      result: { deletedSongId: 7 },
    });
    expect(services.songs.remove).toHaveBeenCalledWith(7);
  });

  it('reports an unknown song as not_found', async () => {
    const { services, spec } = build();
    services.songs.findOne.mockRejectedValue(
      new NotFoundException('Song not found'),
    );
    await expect(spec('song_remove').run(args, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('media_remove', () => {
  const args = { media_id: 11 };
  const group = (overrides: Record<string, unknown>) => ({
    mediaGroups: [
      {
        mediaGroupId: 5,
        position: 0,
        mediaGroup: { id: 5, name: 'Headlines', mediaItems: [{ mediaId: 11 }] },
      },
    ],
    ...overrides,
  });

  it('is refused while a program reading a group that holds it has a scene on air', () =>
    refused(
      'media_remove',
      args,
      (b) => b.live(group({ activeSceneId: 3 })),
      (b) => b.services.media.remove,
      /image 11 is read by program\(s\) on air: main/,
    ));

  it('is refused while fade to black is on, and while a staged scene names its address', async () => {
    await refused(
      'media_remove',
      args,
      (b) => b.live(group({ fadeToBlack: true })),
      (b) => b.services.media.remove,
      /on air: main/,
    );
    await refused(
      'media_remove',
      args,
      (b) => {
        const state = stateOf({ stagedSceneId: 3 }) as any;
        state.scenes[0].scene.metadata = `{"image":"${media.imageUrl}"}`;
        b.programs.listPrograms.mockResolvedValue([state]);
      },
      (b) => b.services.media.remove,
      /on air: main/,
    );
  });

  it('says what is lost and runs while the groups that hold it are off air', async () => {
    const { services, spec, live } = build();
    live(group({}));
    const plan = await spec('media_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(/read by 1 program\(s\) \(main\)/);
    expect(plan.summary).toMatch(/cannot be recovered/);
    await expect(spec('media_remove').run(args, ctx)).resolves.toMatchObject({
      result: { deletedMediaId: 11 },
    });
    expect(services.media.remove).toHaveBeenCalledWith(11, 7);
  });
});

describe('media_asset_remove_standalone_asset', () => {
  const args = { asset_id: 'media:abc' };
  const named =
    (overrides: Record<string, unknown>) => (b: ReturnType<typeof build>) => {
      const state = stateOf(overrides) as any;
      state.scenes[0].scene.metadata = `{"bed":"${asset.sourceUrl}"}`;
      b.programs.listPrograms.mockResolvedValue([state]);
    };

  it('is refused while a scene on air or staged names the asset', async () => {
    await refused(
      'media_asset_remove_standalone_asset',
      args,
      named({ activeSceneId: 3 }),
      (b) => b.services.assets.removeStandaloneAsset,
      /named by a scene on air or staged on main/,
    );
    await refused(
      'media_asset_remove_standalone_asset',
      args,
      named({ stagedSceneId: 3 }),
      (b) => b.services.assets.removeStandaloneAsset,
      /named by a scene on air or staged on main/,
    );
  });

  it('lists what is lost and runs while a scene that names it is off air', async () => {
    const { services, spec, programs } = build();
    named({})({ programs } as never);
    const plan = await spec('media_asset_remove_standalone_asset').dryRun!(
      args,
      ctx,
    );
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(/1 label assignment\(s\)/);
    expect(plan.summary).toMatch(/1 program\(s\) have a scene that names it/);
    await spec('media_asset_remove_standalone_asset').run(args, ctx);
    expect(services.assets.removeStandaloneAsset).toHaveBeenCalledWith(
      'media:abc',
      { permissions: ['alcantara:access'] },
    );
  });

  it('passes the service refusal of a non-standalone asset as invalid', async () => {
    const { services, spec } = build();
    services.assets.removeStandaloneAsset.mockRejectedValue(
      new BadRequestException('Use the capability-specific editor'),
    );
    await expect(
      spec('media_asset_remove_standalone_asset').run(args, ctx),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('media_asset_remove_label', () => {
  const args = { label_id: 'label-1' };

  it('is refused while a scene on air names the label', () =>
    refused(
      'media_asset_remove_label',
      args,
      (b) => {
        const state = stateOf({ activeSceneId: 3 }) as any;
        state.scenes[0].scene.metadata = '{"slides":"label-1"}';
        b.programs.listPrograms.mockResolvedValue([state]);
      },
      (b) => b.services.assets.removeLabel,
      /label label-1 is read by program\(s\) on air: main/,
    ));

  it('is refused for a slideshow label whose mirrored group a live program reads', () =>
    refused(
      'media_asset_remove_label',
      { label_id: 'legacy-media-group:5' },
      (b) => {
        b.services.assets.findLabel.mockResolvedValue({
          ...label,
          id: 'legacy-media-group:5',
        });
        b.live({ fadeToBlack: true });
      },
      (b) => b.services.assets.removeLabel,
      /legacy-media-group:5 is read by program\(s\) on air: main/,
    ));

  it('says what is lost, names the mirrored group, and runs for an idle label', async () => {
    const { services, spec } = build();
    services.assets.findLabel.mockResolvedValue({
      ...label,
      id: 'legacy-media-group:5',
    });
    const plan = await spec('media_asset_remove_label').dryRun!(
      { label_id: 'legacy-media-group:5' },
      ctx,
    );
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(
      /the media group 5 it mirrors with its program assignments/,
    );
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(
      await spec('media_asset_remove_label').confirmTarget!(args, ctx),
    ).toEqual({ id: 'label-1', name: 'Ambience' });
    await spec('media_asset_remove_label').run(args, ctx);
    expect(services.assets.removeLabel).toHaveBeenCalledWith('label-1', {
      permissions: ['alcantara:access'],
    });
  });
});

describe('unusual targets of the D rows', () => {
  it('words an asset with no capability, and treats an unreadable slideshow id as an ordinary label', async () => {
    const { services, spec, programs } = build();
    const state = stateOf({}) as any;
    state.scenes[0].scene.metadata = null;
    programs.listPrograms.mockResolvedValue([state]);
    services.assets.findOne.mockResolvedValue({ ...asset, capabilities: [] });
    const plan = await spec('media_asset_remove_standalone_asset').dryRun!(
      { asset_id: 'media:abc' },
      ctx,
    );
    expect(plan.summary).toMatch(/\(no capability\)/);
    services.assets.findLabel.mockResolvedValue({
      ...label,
      id: 'legacy-media-group:x',
    });
    const labelPlan = await spec('media_asset_remove_label').dryRun!(
      { label_id: 'legacy-media-group:x' },
      ctx,
    );
    expect(labelPlan.summary).not.toMatch(/mirrors/);
  });
});
