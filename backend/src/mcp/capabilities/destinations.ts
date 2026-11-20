import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { BroadcastDestinationsService } from '../../broadcast-destinations/broadcast-destinations.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.broadcast;

/**
 * gaulatti/alcantara#219: the broadcast destination capabilities (the
 * television leg of a program: the catalog of stream destinations and the
 * start, stop and reload commands sent to the executor). Each calls the
 * service its controller calls, in process. A catalog row carries the
 * Secrets Manager reference of its stream key (`secretId`, `secretVersionId`),
 * never the key: the key is read by the executor from Secrets Manager and no
 * service of this repository holds it.
 */
@Injectable()
@McpToolProvider()
export class BroadcastDestinationsMcpTools {
  constructor(private readonly destinations: BroadcastDestinationsService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'destination_list_destinations',
        title: 'List broadcast destinations',
        description:
          'Lists the broadcast destinations an operator may select (id, display name, position, retired), in catalog order.',
        permission: permissions.view,
        shape: {},
        run: () => this.destinations.listDestinations(),
      }),
      readSpec({
        name: 'destination_list_catalog',
        title: 'List the destination catalog',
        description:
          'Lists the full destination catalog with the Secrets Manager reference (not the key) each destination streams with, and its retirement and update times.',
        permission: permissions.manage,
        shape: {},
        run: () => this.destinations.listCatalog(),
      }),
      readSpec({
        name: 'destination_get_program_state',
        title: 'Read the broadcast state of a program',
        description:
          'Reads the television broadcast state of a program: its selectable destinations and what the executor reports (requested and actual state, transition, readiness, active and pending destinations). `available` is false when the executor cannot be reached.',
        permission: permissions.view,
        shape: { program_id: programIdArg },
        run: (args) => this.destinations.getProgramState(args.program_id),
      }),
    ];
  }
}
