import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { SongSimilarityService } from '../../radio/song-similarity.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.radio;

/** The songs a similarity export lists, as the radio tools name them. */
export const SIMILARITY_UNTRUSTED = ['artist', 'title', 'audioUrl'] as const;

/** Rows of one export page: the console sends the whole list; a tool answer must stay small. */
export const EXPORT_PAGE_DEFAULT = 200;
export const EXPORT_PAGE_MAX = 1000;

/**
 * gaulatti/alcantara#218: the song similarity capabilities. They call
 * SongSimilarityService, the service the console's radio similarity routes
 * call, in process.
 */
@Injectable()
@McpToolProvider()
export class SimilarityMcpTools {
  constructor(private readonly similarity: SongSimilarityService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'radio_similarity_coverage',
        title: 'Similarity coverage',
        description:
          'Reports how many enabled songs have a complete embedding for the program window, and how many are missing.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.similarity.getCoverage(args.program_id),
      }),
      readSpec({
        name: 'radio_similarity_decisions',
        title: 'Similarity decisions',
        description:
          'Lists the latest similarity decisions of a program, newest first (default 50, at most 200).',
        permission: permissions.read,
        untrusted: SIMILARITY_UNTRUSTED,
        shape: {
          program_id: programIdArg,
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args) =>
          this.similarity.listDecisions(args.program_id, args.limit ?? 50),
      }),
      readSpec({
        name: 'radio_similarity_export',
        title: 'Export songs for embedding',
        description: `Lists the enabled songs of a program sequence or of the catalog (scope), optionally only those missing an embedding, with the audio address of each. The console sends the whole list; this answer is one page of it (offset, limit; default ${EXPORT_PAGE_DEFAULT}, at most ${EXPORT_PAGE_MAX}) beside the total.`,
        permission: permissions.manage,
        untrusted: SIMILARITY_UNTRUSTED,
        shape: {
          program_id: programIdArg,
          scope: z.enum(['sequence', 'catalog']),
          missing_only: z.boolean().optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(EXPORT_PAGE_MAX).optional(),
        },
        run: async (args) => {
          const exported = await this.similarity.exportSongs(
            args.program_id,
            args.scope,
            args.missing_only === true,
          );
          const offset = args.offset ?? 0;
          const limit = args.limit ?? EXPORT_PAGE_DEFAULT;
          return {
            ...exported,
            total: exported.songs.length,
            offset,
            songs: exported.songs.slice(offset, offset + limit),
          };
        },
      }),
    ];
  }
}
