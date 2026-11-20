import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { AlanaRecordingClient } from '../../recording/alana-recording.client';
import { normalizeProgramId } from '../../recording/recording.controller';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.program;

/**
 * gaulatti/alcantara#219: the program recording and tape capabilities. The
 * route that issues a download ticket is not a capability (appendix A: it
 * returns a credential), and neither status answer carries a link to the file.
 */
@Injectable()
@McpToolProvider()
export class RecordingMcpTools {
  constructor(private readonly recording: AlanaRecordingClient) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'recording_status',
        title: 'Read the recording of a program',
        description:
          'Reads the recording of a program: state, times, size, segments, errors, finalization and disk quota.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) =>
          this.recording.status(normalizeProgramId(args.program_id)),
      }),
      readSpec({
        name: 'recording_tape_status',
        title: 'Read the tape of a program',
        description:
          'Reads the tape (the program-level recording the executor keeps) of a program: whether it is enabled, active and healthy, with the recording it feeds.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) =>
          this.recording.tapeStatus(normalizeProgramId(args.program_id)),
      }),
    ];
  }
}
