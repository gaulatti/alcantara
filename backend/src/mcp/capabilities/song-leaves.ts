import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { loadProgramLive, type ProgramLive } from './on-air';
import { actionSpec, programIdArg } from './support';

/**
 * gaulatti/alcantara#327: program_remove_program_song_leaves_by_id (A, program.operate).
 *
 * Removes exactly the playlist leaves with the given ids from a live program without rewriting the
 * rotation cursor from an old read: program_update_program_audio_bus_by_id writes the whole
 * song sequence it is given, cursor included, and the cursor changes with every song. The service
 * (ProgramService.removeProgramSongLeaves) does a compare-and-swap write against the engine's own
 * cursor and broadcasts the same audio_bus_update as the normal path. The console removes a leaf by
 * sending the whole edited playlist; this is the same edit without the race.
 */
@Injectable()
@McpToolProvider()
export class SongLeavesMcpTools {
  constructor(private readonly programs: ProgramService) {}

  specs(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'program_remove_program_song_leaves_by_id',
        title: 'Remove songs from the playlist of a program by leaf id',
        description:
          'Removes exactly the playlist leaves with these ids (1 to 200, nested blocks included) and changes nothing else: the rotation cursor is the live one, never rewritten from an old read. An unknown id is refused. Removing the leaf on air is refused unless keep_rotation is set, which moves the rotation to the next leaf. With dry_run the leaves that would go and the leaf counts before and after are returned and nothing is written.',
        permission: ALCANTARA_PERMISSIONS.program.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          leaf_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
          keep_rotation: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
        load: (args) => loadProgramLive(this.programs, args.program_id),
        id: (args) => args.program_id,
        label: (_args, live: ProgramLive) => live.stamp,
        plan: (args, live: ProgramLive) => ({
          summary:
            args.dry_run === true
              ? `Lists the ${args.leaf_ids.length} playlist leaf(s) of program ${args.program_id} that would be removed; nothing is written. Live now: ${live.liveText}.`
              : `Removes ${args.leaf_ids.length} leaf(s) from the playlist of program ${args.program_id}; the rotation keeps its place${args.keep_rotation === true ? ' (moved on if the leaf on air is among them)' : ''}. Live now: ${live.liveText}. Removed leaves are not kept: a dry run lists them first.`,
          affects: [
            {
              kind: 'program',
              id: args.program_id,
              name: args.program_id,
            },
          ],
          recoverable: false,
        }),
        run: (args) =>
          this.programs.removeProgramSongLeaves(
            args.program_id,
            args.leaf_ids,
            { keepRotation: args.keep_rotation, dryRun: args.dry_run },
          ),
        result: (raw, args) => ({
          program_id: args.program_id,
          ...(raw as object),
        }),
      }),
    ];
  }
}
