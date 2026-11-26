/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- tool answers are untyped JSON. */
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { MediaAssetsService } from '../../media-assets/media-assets.service';
import { MediaService } from '../../media/media.service';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { PompeiiService } from '../../auth/pompeii.service';
import { ProgramService } from '../../program/program.service';
import { SongSimilarityService } from '../../radio/song-similarity.service';
import { SongsService } from '../../songs/songs.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { principalWith } from './capabilities.testing';
import {
  asset,
  assetsPage,
  coverage,
  mediaPage,
  songsPage,
} from './media-area.testing';
import { MediaAssetsMcpTools } from './media-assets';
import { MediaMcpTools } from './media';
import { SimilarityMcpTools } from './similarity';
import { SongsMcpTools } from './songs';

// The providers found through Nest discovery and run on the registry's real
// call path: a caller sees and may call only what its permissions allow.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

const permissions = ALCANTARA_PERMISSIONS;

async function connect(principal: ReturnType<typeof principalWith>) {
  const fakes = {
    songs: {
      findAll: jest.fn().mockResolvedValue(songsPage),
      findOne: jest.fn().mockResolvedValue(songsPage.data[0]),
      remove: jest.fn().mockResolvedValue({ deletedSongId: 7 }),
    },
    programs: {
      listPrograms: jest.fn().mockResolvedValue([
        {
          programId: 'main',
          activeSceneId: null,
          stagedSceneId: null,
          fadeToBlack: false,
          songSequence: null,
          songQueue: [],
          scenes: [],
          mediaGroups: [],
        },
      ]),
      getProgramSongPlayback: jest.fn().mockResolvedValue({
        isPlaying: false,
        audioUrl: '',
      }),
    },
    media: {
      findAll: jest.fn().mockResolvedValue(mediaPage),
      remove: jest.fn(),
    },
    assets: {
      findAll: jest.fn().mockResolvedValue(assetsPage),
      findOne: jest.fn().mockResolvedValue(asset),
    },
    similarity: { getCoverage: jest.fn().mockResolvedValue(coverage) },
  };
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: fakes.programs },
      { provide: PompeiiService, useValue: { teamId: 7 } },
      { provide: SongsService, useValue: fakes.songs },
      { provide: MediaService, useValue: fakes.media },
      { provide: MediaAssetsService, useValue: fakes.assets },
      { provide: SongSimilarityService, useValue: fakes.similarity },
      SongsMcpTools,
      MediaMcpTools,
      MediaAssetsMcpTools,
      SimilarityMcpTools,
    ],
  }).compile();
  await module.init();
  const tools = new Map<string, Handler>();
  const reauthorize = jest.fn(() => Promise.resolve(principal));
  module.get(McpRegistry).register(
    {
      registerTool: (
        name: string,
        _config: { inputSchema: z.ZodRawShape },
        handler: Handler,
      ) => tools.set(name, handler),
    } as never,
    principal,
    reauthorize as never,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await tools.get(name)!(args);
    return {
      body: JSON.parse(answer.content[0].text),
      isError: answer.isError === true,
    };
  };
  const capability = (name: string, args: Record<string, unknown>) =>
    call('call_capability', { name, arguments: args });
  const names = async () =>
    (
      (await call('list_capabilities', { limit: 100 })).body
        .capabilities as Array<{ name: string }>
    ).map((c) => c.name);
  return { module, capability, names, fakes, reauthorize };
}

const AREA = /^(song_|media_find|media_asset_|radio_similarity_)/;

describe('song, media, asset and similarity capabilities through the registry', () => {
  it('shows every capability to a caller who holds the permissions (the asset and label writes need media.manage), and runs a read', async () => {
    const { module, names, capability } = await connect(
      principalWith(
        permissions.access,
        permissions.song.read,
        permissions.media.read,
        permissions.media.manage,
        permissions.radio.read,
        permissions.radio.manage,
      ),
    );
    expect((await names()).filter((n) => AREA.test(n)).sort()).toEqual([
      'media_asset_create_background_audio',
      'media_asset_create_label',
      'media_asset_find_all',
      'media_asset_find_label',
      'media_asset_find_labels',
      'media_asset_find_one',
      'media_asset_remove_label',
      'media_asset_remove_standalone_asset',
      'media_asset_replace_asset_labels',
      'media_asset_replace_label_assets',
      'media_asset_update_label',
      'media_find_all',
      'media_find_one',
      'radio_similarity_coverage',
      'radio_similarity_decisions',
      'radio_similarity_export',
      'radio_similarity_upload',
      'song_find_all',
      'song_find_one',
    ]);
    const songs = await capability('song_find_all', {});
    expect(songs.isError).toBe(false);
    expect(songs.body.data[0].untrusted.artist).toContain('The Band');
    await module.close();
  });

  it.each([
    ['song_find_all', {}],
    ['media_find_all', {}],
    ['radio_similarity_coverage', { program_id: 'main' }],
    ['radio_similarity_export', { program_id: 'main', scope: 'catalog' }],
  ])(
    'does not list %s for a caller without its permission and refuses the call',
    async (name, args) => {
      const { module, names, capability, fakes } = await connect(
        principalWith(permissions.access),
      );
      expect(await names()).not.toContain(name);
      const refused = await capability(name, args);
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toBe('forbidden');
      expect(fakes.songs.findAll).not.toHaveBeenCalled();
      expect(fakes.media.findAll).not.toHaveBeenCalled();
      expect(fakes.similarity.getCoverage).not.toHaveBeenCalled();
      await module.close();
    },
  );

  it('hands the service the permissions of the caller, so its per-asset checks decide', async () => {
    const principal = principalWith(permissions.access, permissions.song.read);
    const { module, capability, fakes } = await connect(principal);
    await capability('media_asset_find_all', {});
    expect(fakes.assets.findAll).toHaveBeenCalledWith(expect.anything(), {
      permissions: [permissions.access, permissions.song.read],
    });
    await module.close();
  });

  it.each([
    [
      'media_asset_create_label',
      { name: 'x', idempotency_key: 'key-00000001' },
    ],
    [
      'media_asset_remove_label',
      { label_id: 'l', confirm: 'c', idempotency_key: 'key-00000001' },
    ],
    [
      'song_create',
      {
        audio_url: 'https://cdn.example/a.mp3',
        idempotency_key: 'key-00000001',
      },
    ],
    [
      'radio_similarity_upload',
      { program_id: 'main', upload: {}, idempotency_key: 'key-00000001' },
    ],
    [
      'song_remove',
      { song_id: 7, confirm: 'c', idempotency_key: 'key-00000001' },
    ],
    [
      'media_remove',
      { media_id: 11, confirm: 'c', idempotency_key: 'key-00000001' },
    ],
  ])(
    'does not list the write %s for a caller without its permission and refuses it',
    async (name, args) => {
      const { module, names, capability, fakes } = await connect(
        principalWith(permissions.access),
      );
      expect(await names()).not.toContain(name);
      const refused = await capability(name, args);
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toBe('forbidden');
      expect(fakes.songs.remove).not.toHaveBeenCalled();
      expect(fakes.media.remove).not.toHaveBeenCalled();
      await module.close();
    },
  );

  it('runs a D capability through dry run, confirm and idempotency, asking Pompeii again, and refuses a song on air', async () => {
    const principal = principalWith(
      permissions.access,
      permissions.song.manage,
      permissions.song.read,
    );
    const { module, capability, fakes, reauthorize } = await connect(principal);
    const dry = await capability('song_remove', {
      song_id: 7,
      dry_run: true,
      idempotency_key: 'key-00000002',
    });
    expect(dry.body).toMatchObject({ dry_run: true, onAir: false });
    const missing = await capability('song_remove', {
      song_id: 7,
      idempotency_key: 'key-00000002',
    });
    expect(missing.body.error).toBe('confirm_required');
    const done = await capability('song_remove', {
      song_id: 7,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000002',
    });
    expect(done.isError).toBe(false);
    expect(fakes.songs.remove).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalled();

    fakes.programs.getProgramSongPlayback.mockResolvedValue({
      isPlaying: true,
      audioUrl: songsPage.data[0].audioUrl,
    });
    fakes.songs.remove.mockClear();
    const live = await capability('song_remove', {
      song_id: 7,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000003',
    });
    expect(live.isError).toBe(true);
    expect(live.body.error).toBe('on_air');
    expect(fakes.songs.remove).not.toHaveBeenCalled();
    await module.close();
  });
});
