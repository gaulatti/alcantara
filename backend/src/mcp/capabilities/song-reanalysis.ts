import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import {
  MAX_REANALYSIS_BATCH,
  REANALYSIS_RULES,
  SongReanalysisService,
} from '../../songs/song-reanalysis.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, rowIdArg } from './support';
import { whyNot } from './on-air';

/** gaulatti/alcantara#235: queue songs for a new analysis, a few at a time, never one that is on air. */
@McpToolProvider()
@Injectable()
export class SongReanalysisMcpTools {
  constructor(private readonly reanalysis: SongReanalysisService) {}

  specs(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'song_request_reanalysis',
        title: 'Analyse songs again',
        description: `Queues up to ${MAX_REANALYSIS_BATCH} songs for a new audio analysis (cue points and loudness). The media-analysis job takes them one at a time at low priority; a song keeps its current cue points and loudness until a new successful result replaces them, also while its analysis runs and when it fails. A song that is playing on a program or announced there as the next song is refused with on_air (listed per song in the dry run). Songs that are not found or have no finished analysis are listed, not queued. rule is C2 (the default, the current cue rule: a quiet tail longer than the 1.5 s bound is cut exactly 1.5 s past the old cue-out), C (the rule before that, which keeps the old cue-out there) or previous (the cue rule before gaulatti/alcantara#235); C and previous are a way back for a bad batch that needs no deploy; the rule that ran is recorded as the song's ruleVersion.`,
        permission: ALCANTARA_PERMISSIONS.song.manage,
        tier: 'W',
        shape: {
          song_ids: z.array(rowIdArg).min(1).max(MAX_REANALYSIS_BATCH),
          rule: z.enum(REANALYSIS_RULES).optional(),
        },
        load: async (args) => ({
          onAir: await this.reanalysis.onAir(args.song_ids),
        }),
        id: (args) => args.song_ids.join(','),
        plan: (args, { onAir }) => ({
          summary: `Queues ${args.song_ids.length} song(s) for a new analysis on rule ${args.rule ?? 'C2'}: ${args.song_ids.join(', ')}. Their cue points and loudness are replaced as each analysis finishes; nothing else changes. On air now: ${
            [...onAir]
              .filter(([, programs]) => programs.length > 0)
              .map(([id, programs]) => `song ${id} on ${programs.join(', ')}`)
              .join('; ') || 'none'
          }.`,
          affects: args.song_ids.map((id) => ({
            kind: 'song',
            id: String(id),
            name: String(id),
          })),
          recoverable: true,
        }),
        refuse: (_args, { onAir }) =>
          whyNot(
            [...onAir].map(
              ([id, programs]) =>
                [
                  programs.length > 0,
                  `song ${id} is on air on ${programs.join(', ')}`,
                ] as const,
            ),
          ),
        run: (args) => this.reanalysis.request(args.song_ids, args.rule),
      }),
    ];
  }
}
