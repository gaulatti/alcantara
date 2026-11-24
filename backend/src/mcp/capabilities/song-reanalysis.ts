import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { MAX_REANALYSIS_BATCH, SongsService } from '../../songs/songs.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, rowIdArg } from './support';

/** gaulatti/alcantara#235: queue songs for a new analysis, a few at a time. */
@McpToolProvider()
@Injectable()
export class SongReanalysisMcpTools {
  constructor(private readonly songs: SongsService) {}

  specs(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'song_request_reanalysis',
        title: 'Analyse songs again',
        description: `Queues up to ${MAX_REANALYSIS_BATCH} songs for a new audio analysis (cue points and loudness). The media-analysis job takes them one at a time at low priority; a song keeps its current cue points until its new result replaces them, and plays without cue points while its analysis runs. Songs that are not found or have no finished analysis are listed, not queued.`,
        permission: ALCANTARA_PERMISSIONS.song.manage,
        tier: 'W',
        shape: {
          song_ids: z.array(rowIdArg).min(1).max(MAX_REANALYSIS_BATCH),
        },
        id: (args) => args.song_ids.join(','),
        plan: (args) => ({
          summary: `Queues ${args.song_ids.length} song(s) for a new analysis: ${args.song_ids.join(', ')}. Their cue points and loudness are replaced as each analysis finishes; nothing else changes.`,
          affects: args.song_ids.map((id) => ({
            kind: 'song',
            id: String(id),
            name: String(id),
          })),
          recoverable: true,
        }),
        run: (args) => this.songs.requestReanalysis(args.song_ids),
      }),
    ];
  }
}
