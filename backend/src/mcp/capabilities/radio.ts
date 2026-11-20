import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { NowPlayingPublisherService } from '../../radio/now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from '../../radio/palazzo-telemetry.service';
import { RadioOutputConfidenceService } from '../../radio/radio-output-confidence.service';
import { RadioService } from '../../radio/radio.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.radio;

/**
 * gaulatti/alcantara#219: the radio capabilities that are not songs or
 * similarity (#218): settings, the Palazzo and output confidence reads, the
 * recovery (filler) session, the now-playing consumers and the manual song and
 * instant routes. The monitor ticket route is not a capability (appendix A: it
 * returns a credential).
 *
 * A now-playing consumer's request headers can carry an API key. They are
 * never returned: an answer lists each consumer's `headerNames` (under
 * `untrusted`) and nothing of the values.
 */
@Injectable()
@McpToolProvider()
export class RadioMcpTools {
  constructor(
    private readonly radio: RadioService,
    private readonly consumers: NowPlayingPublisherService,
    private readonly telemetry: PalazzoRadioTelemetryService,
    private readonly confidence: RadioOutputConfidenceService,
  ) {}

  specs(): McpToolSpec[] {
    return [...this.reads()];
  }

  private reads(): McpToolSpec[] {
    const programArg = { program_id: programIdArg };
    return [
      readSpec({
        name: 'radio_get_settings',
        title: 'Read the radio settings of a program',
        description:
          'Reads the radio settings of a program (Palazzo address, listener address, bumpers, recovery playlist, segue and similarity settings); null when the program has none yet.',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getRadioSettings(args.program_id),
      }),
      readSpec({
        name: 'radio_get_palazzo_status',
        title: 'Read the Palazzo link of a program',
        description:
          'Reads the live link to the Palazzo audio engine of a program (connection, last event and snapshot times, degraded flag); null when the program has no link.',
        permission: permissions.read,
        shape: programArg,
        run: (args) =>
          Promise.resolve(this.telemetry.getStatus(args.program_id)),
      }),
      readSpec({
        name: 'radio_get_output_confidence',
        title: 'Read the output confidence of a program',
        description:
          'Reads whether audio is actually leaving the radio output of a program (state, expected audio, level and silence).',
        permission: permissions.read,
        shape: programArg,
        run: async (args) => {
          await this.radio.getRadioSettings(args.program_id);
          return this.confidence.get(args.program_id);
        },
      }),
      readSpec({
        name: 'radio_get_recovery',
        title: 'Read the recovery session of a program',
        description:
          'Reads the recovery (filler) session of a radio program: the selected songs, the prepared version and Palazzo\'s automation state; `connection` is "unavailable" when Palazzo cannot be reached.',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getRecoveryStatus(args.program_id),
      }),
      readSpec({
        name: 'radio_list_now_playing_consumers',
        title: 'List the now-playing consumers of a program',
        description:
          'Lists the endpoints that are told what is playing: name, address, method, enabled and position. Header values are never returned; `headerNames` lists the names of the headers a consumer sends.',
        permission: permissions.read,
        shape: programArg,
        run: async (args) =>
          withoutHeaderValues(
            await this.consumers.listConsumers(args.program_id),
          ),
      }),
      readSpec({
        name: 'radio_now_playing_publishing',
        title: 'Read whether now-playing updates leave the machine',
        description:
          'Says whether now-playing updates are published ("enabled") or held back on a local stack ("blocked-local").',
        permission: permissions.read,
        shape: programArg,
        run: () =>
          Promise.resolve({
            publishing: this.consumers.outboundPublishing(),
          }),
      }),
      readSpec({
        name: 'radio_get_status',
        title: 'Read whether the radio output is running',
        description:
          'Reads whether the radio engine of a program is running (liquidsoap and icecast connected).',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getPalazzoStatus(args.program_id),
      }),
    ];
  }
}

interface ConsumerRow {
  headers: unknown;
  [key: string]: unknown;
}

/** A consumer as stored, with the names of its headers instead of their values. */
export function withoutHeaderValues(rows: unknown): unknown[] {
  return (rows as ConsumerRow[]).map(({ headers, ...rest }) => ({
    ...rest,
    headerNames:
      headers && typeof headers === 'object' && !Array.isArray(headers)
        ? Object.keys(headers)
        : [],
  }));
}
