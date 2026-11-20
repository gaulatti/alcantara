import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { FillerService } from '../../filler/filler.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.broadcast;

/**
 * gaulatti/alcantara#219: the per-program filler capabilities (the media the
 * television and radio legs play when nothing else does).
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
    ];
  }
}
