import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { FillerService } from '../../filler/filler.service';
import { z } from 'zod';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.broadcast;

const assetIdArg = z.string().trim().min(1).max(128);

/**
 * gaulatti/alcantara#219: the per-program filler capabilities (the media the
 * television and radio legs play when nothing else does). Preparing a filler
 * only ever writes the leg's pending (next session) version: the version in
 * session is changed by a broadcast start or a recovery start, never here, so
 * neither row changes what is on air.
 */
@Injectable()
@McpToolProvider()
export class FillerMcpTools {
  constructor(private readonly fillers: FillerService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'filler_get_state',
        title: 'Read the filler of a program',
        description:
          'Reads the pending (next session) and active (in session) filler version of each leg of a program: checksum, status, sources and order.',
        permission: permissions.view,
        shape: { program_id: programIdArg },
        run: (args) => this.fillers.getState(args.program_id),
      }),
      actionSpec({
        name: 'filler_prepare_television',
        title: 'Prepare the television filler of a program',
        description:
          'Prepares an enabled image or video media asset as the television filler of a program: the executor must acknowledge the exact asset before the version becomes the pending (next session) filler. It does not change what is on air.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, asset_id: assetIdArg },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Prepares media asset ${args.asset_id} as a new television filler version of program ${args.program_id}: the asset is read to take its SHA-256 and the executor downloads it. On success it becomes the pending version used by the next television start; the version in session is untouched. A failed preparation leaves the current versions as they are.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
            { kind: 'media_asset', id: args.asset_id, name: args.asset_id },
          ],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          this.fillers.prepareTelevision(
            args.program_id,
            { assetId: args.asset_id },
            ctx.principal.subject,
          ),
      }),
      actionSpec({
        name: 'filler_prepare_radio',
        title: 'Prepare the radio filler of a program',
        description:
          'Prepares one to 100 distinct enabled audio media assets as the radio filler of a program, in order or shuffled with a seed. Palazzo must accept them before the version becomes the pending (next session) filler. It does not change what is on air.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          asset_ids: z.array(assetIdArg).min(1).max(100),
          mode: z.enum(['ordered', 'shuffle']).optional(),
          shuffle_seed: z.string().trim().min(1).max(64).optional(),
        },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Prepares ${args.asset_ids.length} audio asset(s), ${args.mode ?? 'ordered'}, as a new radio filler version of program ${args.program_id}: each asset is read to take its SHA-256 and Palazzo downloads them. On success it becomes the pending version the next recovery start binds; a recovery session already running keeps the version it started with.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
            ...args.asset_ids.map((id) => ({
              kind: 'media_asset',
              id,
              name: id,
            })),
          ],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          this.fillers.prepareRadio(
            args.program_id,
            {
              assetIds: args.asset_ids,
              mode: args.mode,
              shuffleSeed: args.shuffle_seed,
            },
            ctx.principal.subject,
          ),
      }),
      actionSpec({
        name: 'filler_remove_television',
        title: 'Remove the television filler of a program',
        description:
          'Removes the configured television filler of a program, so a broadcast start no longer binds or checks one. Nothing is sent to Alana and nothing on air changes. Prepare it again with filler_prepare_television.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Removes the television filler configuration of program ${args.program_id}. The next broadcast start binds no filler version; what Alana already holds is not touched.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) => this.fillers.removeTelevision(args.program_id),
      }),
      actionSpec({
        name: 'filler_remove_radio',
        title: 'Remove the radio filler of a program',
        description:
          'Removes the configured radio filler of a program, so the older recovery playlist is what the next recovery start binds. It does not change what is on air; a running session keeps the version it started with. Prepare it again with filler_prepare_radio.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Removes the radio filler configuration of program ${args.program_id}. The next recovery start binds the older recovery playlist, if one was prepared; a session already running keeps its version.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) => this.fillers.removeRadio(args.program_id),
      }),
    ];
  }
}
