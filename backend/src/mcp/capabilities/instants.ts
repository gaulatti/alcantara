import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.instant;

/** An instant's audio address was typed or imported by people. */
const INSTANT_UNTRUSTED = ['audioUrl'] as const;

/**
 * gaulatti/alcantara#217: the instant capabilities. They call ProgramService,
 * the service the console's instants routes call, in process.
 */
@Injectable()
@McpToolProvider()
export class InstantsMcpTools {
  constructor(private readonly programs: ProgramService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'instant_list_instants',
        title: 'List instants',
        description:
          'Lists every instant (a short audio clip played over the program) in the console order, with whether it can still be assigned as a song intro and, for program_id (default main), which song it introduces there.',
        permission: permissions.read,
        untrusted: INSTANT_UNTRUSTED,
        shape: { program_id: programIdArg.optional() },
        run: (args) => this.programs.listInstants(args.program_id),
      }),
    ];
  }
}
