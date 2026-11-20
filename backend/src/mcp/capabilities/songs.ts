import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { SongsService } from '../../songs/songs.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.song;

/** Song text and addresses were typed or imported by people. */
export const SONG_UNTRUSTED = [
  'artist',
  'title',
  'audioUrl',
  'coverUrl',
  'sourceUrl',
] as const;

const programIdArg = z.string().trim().min(1).max(100);

/**
 * gaulatti/alcantara#218: the song capabilities. They call SongsService, the
 * service the console's songs routes call, in process.
 */
@Injectable()
@McpToolProvider()
export class SongsMcpTools {
  constructor(private readonly songs: SongsService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'song_find_all',
        title: 'List songs',
        description:
          'Lists the song catalog, paged as the console pages it (default 50 per page; at most 200, where the console also accepts 0 for the whole catalog). program_id selects whose intro Instant is shown (default main).',
        permission: permissions.read,
        untrusted: SONG_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          enabled: z.boolean().optional(),
          sort_by: z
            .enum([
              'id',
              'artist',
              'title',
              'durationMs',
              'updatedAt',
              'createdAt',
              'enabled',
            ])
            .optional(),
          sort_order: z.enum(['asc', 'desc']).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          program_id: programIdArg.optional(),
        },
        run: (args) =>
          this.songs.findAll({
            search: args.search,
            enabled: args.enabled,
            sortBy: args.sort_by,
            sortOrder: args.sort_order,
            page: args.page ?? 1,
            limit: args.limit ?? 50,
            programId: args.program_id,
          }),
      }),
      readSpec({
        name: 'song_find_one',
        title: 'Get a song',
        description:
          "Returns one song with its intro Instant for a program (default main). The song's audio analysis is not part of this answer.",
        permission: permissions.read,
        untrusted: SONG_UNTRUSTED,
        shape: { song_id: rowIdArg, program_id: programIdArg.optional() },
        run: (args) => this.songs.findOne(args.song_id, args.program_id),
      }),
    ];
  }
}
