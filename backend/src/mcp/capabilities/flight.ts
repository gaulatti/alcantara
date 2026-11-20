import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { FlightService } from '../../program/flight.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.flight;

/**
 * gaulatti/alcantara#215: the flight (rundown) capabilities, the program
 * routes under /program/:programId/flight. Each calls the FlightService
 * method its controller calls, in process, with the caller already
 * authorized by the registry.
 */
@Injectable()
@McpToolProvider()
export class FlightMcpTools {
  constructor(private readonly flights: FlightService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'program_list_flight_sequences_by_id',
        title: 'List the flight sequences (rundowns) of a program',
        description:
          'Lists the flight sequences of a program with their cues, schedule, publication state, revision and whether each is running (GET /program/:programId/flight).',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.flights.listFlightSequences(args.program_id),
      }),
      readSpec({
        name: 'program_preflight_flight_sequence_by_id',
        title: 'Check that a clocked log can air',
        description:
          'Checks that every song and clip of a clocked log (a sequence with a scheduled start) is available to play; answers `ready` and the `issues` found. A sequence with no scheduled start is refused as invalid.',
        permission: permissions.read,
        shape: { program_id: programIdArg, sequence_id: rowIdArg },
        run: (args) =>
          this.flights.preflightFlightSequence(
            args.program_id,
            args.sequence_id,
          ),
      }),
    ];
  }
}
