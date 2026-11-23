import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { AlanaRecordingClient } from '../../recording/alana-recording.client';
import {
  normalizeCommandKey,
  normalizeProgramId,
} from '../../recording/recording.controller';
import type {
  RecordingStatus,
  TapeStatus,
} from '../../recording/recording.contract';
import { z } from 'zod';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.program;

/** The executor's replay key (the console's Idempotency-Key header). */
const commandKeyArg = z.string().trim().min(1).max(200);

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
      ...this.commands('recording', 'program recording', {
        load: (id) => this.recording.status(id),
        stamp: (status) => (status as RecordingStatus).state,
        run: (id, action, key) => this.recording.command(id, action, key),
        startText:
          'Starts recording the program output on the executor: it writes segments to its disk, up to the quota, until stopped.',
        stopText:
          'Stops the recording and finalizes it into one file. A stopped recording cannot be resumed: a later start begins a new one.',
      }),
      ...this.commands('recording_tape', 'program tape', {
        load: (id) => this.recording.tapeStatus(id),
        stamp: (status) => {
          const tape = status as TapeStatus;
          return `${tape.tape.active ? 'active' : 'idle'}/${tape.recording.state}`;
        },
        run: (id, action, key) => this.recording.tapeCommand(id, action, key),
        startText:
          'Starts the tape of the program on the executor (the executor refuses while the program is live and answers program-live).',
        stopText:
          'Stops the tape and finalizes the recording it feeds. A stopped tape cannot be resumed: a later start begins a new one.',
      }),
    ];
  }

  private commands(
    prefix: string,
    noun: string,
    def: {
      load: (programId: string) => Promise<unknown>;
      stamp: (status: unknown) => string;
      run: (
        programId: string,
        action: 'start' | 'stop',
        key: string,
      ) => Promise<unknown>;
      startText: string;
      stopText: string;
    },
  ): McpToolSpec[] {
    return (['start', 'stop'] as const).map((action) =>
      actionSpec({
        name: `${prefix}_${action}`,
        title: `${action === 'start' ? 'Start' : 'Stop'} the ${noun}`,
        description: `${action === 'start' ? def.startText : def.stopText} command_key is the executor's replay key: the same key returns the recorded result instead of running again.`,
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg, command_key: commandKeyArg },
        load: (args) => def.load(normalizeProgramId(args.program_id)),
        id: (args) => args.program_id,
        label: (_args, status) => def.stamp(status),
        plan: (args, status) => ({
          summary: `${action === 'start' ? def.startText : def.stopText} Now: ${def.stamp(status)}.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: action === 'start',
        }),
        run: (args) =>
          def.run(
            normalizeProgramId(args.program_id),
            action,
            normalizeCommandKey(args.command_key),
          ),
      }),
    );
  }
}
