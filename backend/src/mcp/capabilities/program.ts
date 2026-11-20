import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

/**
 * gaulatti/alcantara#216: the program capabilities (the program routes that
 * are not flight, radio or recording). Each calls the service its controller
 * calls, in process, with the caller already authorized by the registry.
 */
@Injectable()
@McpToolProvider()
export class ProgramMcpTools {
  constructor(private readonly programs: ProgramService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'program_list_programs',
        title: 'List programs in full',
        description:
          'Lists every program with its type, template, scenes, media groups, stingers, flight sequences and audio settings, as the console loads them.',
        permission: ALCANTARA_PERMISSIONS.program.read,
        shape: {},
        run: () => this.programs.listPrograms(),
      }),
      readSpec({
        name: 'program_get_staged_scene_by_id',
        title: 'Get the staged scene of a program',
        description:
          'Reads the scene staged to go on air next on a television program (null when none).',
        permission: ALCANTARA_PERMISSIONS.program.read,
        shape: { program_id: programIdArg },
        run: (args) => this.programs.getStagedScene(args.program_id),
      }),
    ];
  }
}
