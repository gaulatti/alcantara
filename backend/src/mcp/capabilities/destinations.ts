import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { BroadcastDestinationsService } from '../../broadcast-destinations/broadcast-destinations.service';
import { z } from 'zod';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.broadcast;

const destinationIdArg = z.string().trim().min(1).max(64);
const displayNameArg = z.string().trim().min(1).max(100);
const secretIdArg = z.string().trim().min(1).max(512);
const secretVersionIdArg = z.string().trim().min(1).max(128);
/** A stable command id: the executor replays the recorded result for a repeat. */
const commandIdArg = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const selectionVersionArg = z.string().trim().min(1).max(128).optional();

interface CatalogRow {
  id: string;
  displayName: string;
  retiredAt: Date | null;
}

interface ProgramBroadcast {
  available: boolean;
  downstream: {
    requestedState: string;
    actualState: string;
    transition: string | null;
  };
}

/** Where the executor is, in words; it changes when a start or stop lands. */
const stateStamp = (state: ProgramBroadcast): string =>
  state.available
    ? `requested=${state.downstream.requestedState} actual=${state.downstream.actualState} transition=${state.downstream.transition ?? 'none'}`
    : 'executor-unavailable';

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
    return [...this.reads(), ...this.catalogWrites(), ...this.commands()];
  }

  private reads(): McpToolSpec[] {
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

  /** The catalog row of a destination; the plan and the refusal start from it. */
  private async catalogRow(id: string): Promise<CatalogRow> {
    const row = ((await this.destinations.listCatalog()) as CatalogRow[]).find(
      (candidate) => candidate.id === id,
    );
    if (!row) throw new McpToolError('not_found', 'Destination not found');
    return row;
  }

  private catalogWrites(): McpToolSpec[] {
    const reference = {
      secret_id: secretIdArg,
      secret_version_id: secretVersionIdArg,
    };
    return [
      actionSpec({
        name: 'destination_create_destination',
        title: 'Add a broadcast destination',
        description:
          'Adds a destination to the end of the catalog: an id, a display name and the Secrets Manager reference (secret id and pinned version id) of its stream key. The key itself is never read or returned.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          id: destinationIdArg,
          display_name: displayNameArg,
          ...reference,
        },
        id: (args) => args.id,
        plan: (args) => ({
          summary: `Adds destination ${args.id} at the end of the catalog. It becomes selectable for the next start; nothing on air changes. It can be retired later (destinations are never deleted).`,
          affects: [{ kind: 'destination', id: args.id, name: args.id }],
          recoverable: true,
        }),
        run: (args) =>
          this.destinations.createDestination({
            id: args.id,
            displayName: args.display_name,
            secretId: args.secret_id,
            secretVersionId: args.secret_version_id,
          }),
      }),
      actionSpec({
        name: 'destination_reorder_destinations',
        title: 'Reorder the broadcast destinations',
        description:
          'Sets the catalog order. The list must contain every destination in the catalog, retired ones included, once each.',
        permission: permissions.manage,
        tier: 'W',
        shape: { destination_ids: z.array(destinationIdArg).max(100) },
        id: () => 'destination-order',
        plan: (args) => ({
          summary: `Sets the order of ${args.destination_ids.length} destination(s). Only the order shown to operators changes; the previous order is not kept.`,
          affects: args.destination_ids.map((id) => ({
            kind: 'destination',
            id,
            name: id,
          })),
          recoverable: true,
        }),
        run: (args) =>
          this.destinations.reorderDestinations(args.destination_ids),
      }),
      actionSpec({
        name: 'destination_update_destination',
        title: 'Update a broadcast destination',
        description:
          'Replaces the display name and the Secrets Manager reference of a destination (all three are required, as the console sends them).',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          destination_id: destinationIdArg,
          display_name: displayNameArg,
          ...reference,
        },
        load: (args) => this.catalogRow(args.destination_id),
        id: (args) => args.destination_id,
        plan: (args) => ({
          summary: `Replaces the name and stream key reference of destination ${args.destination_id}. A running broadcast keeps the immutable selection it started with; the new reference applies from the next start. The previous values are not kept: read the catalog first to restore them.`,
          affects: [
            {
              kind: 'destination',
              id: args.destination_id,
              name: args.destination_id,
            },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.destinations.updateDestination(args.destination_id, {
            displayName: args.display_name,
            secretId: args.secret_id,
            secretVersionId: args.secret_version_id,
          }),
      }),
      ...[
        ['retire', true],
        ['restore', false],
      ].map(([verb, retired]) =>
        actionSpec({
          name: `destination_${verb as string}_destination`,
          title: `${verb === 'retire' ? 'Retire' : 'Restore'} a broadcast destination`,
          description:
            verb === 'retire'
              ? 'Retires a destination: it can no longer be selected for a start (a replay of an older selection that includes it is refused too). A running broadcast keeps streaming to it until stopped. Restore undoes it.'
              : 'Restores a retired destination so it can be selected again.',
          permission: permissions.manage,
          tier: 'W',
          shape: { destination_id: destinationIdArg },
          load: (args) => this.catalogRow(args.destination_id),
          id: (args) => args.destination_id,
          plan: (args, row) => ({
            summary:
              verb === 'retire'
                ? `Retires destination ${args.destination_id}${row.retiredAt ? ' (already retired; the retirement time is renewed)' : ''}: later starts refuse it; a running broadcast keeps its selection. Recoverable with destination_restore_destination.`
                : `Restores destination ${args.destination_id}${row.retiredAt ? '' : ' (it is not retired; nothing changes)'}: it can be selected again.`,
            affects: [
              {
                kind: 'destination',
                id: args.destination_id,
                name: args.destination_id,
              },
            ],
            recoverable: true,
          }),
          run: (args) =>
            this.destinations.setRetired(
              args.destination_id,
              retired as boolean,
            ),
        }),
      ),
    ];
  }

  /**
   * The start, stop and reload commands. The console asks the operator to
   * confirm and sends `confirmed: true`; here the framework's confirm string
   * plays that part, so the capability sends it only after the confirm
   * matched. `command_id` is the executor's replay key (the console's
   * commandId).
   */
  private commands(): McpToolSpec[] {
    const row = (
      verb: 'start' | 'stop' | 'reload',
      title: string,
      description: string,
      what: (ids: string[], state: ProgramBroadcast) => string,
      recoverable: boolean,
    ): McpToolSpec => {
      const withIds = verb !== 'stop';
      return actionSpec({
        name: `destination_${verb}`,
        title,
        description,
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          command_id: commandIdArg,
          ...(withIds
            ? {
                destination_ids: z.array(destinationIdArg).min(1).max(20),
                selection_version: selectionVersionArg,
              }
            : {}),
        },
        load: (args) =>
          this.destinations.getProgramState(
            args.program_id,
          ) as Promise<ProgramBroadcast>,
        id: (args) => args.program_id,
        label: (_args, state) => stateStamp(state),
        plan: (args, state) => ({
          summary: what(
            (args as { destination_ids?: string[] }).destination_ids ?? [],
            state,
          ),
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
            ...(
              (args as { destination_ids?: string[] }).destination_ids ?? []
            ).map((id) => ({ kind: 'destination', id, name: id })),
          ],
          recoverable,
        }),
        run: (args, _state, ctx) => {
          const body = args as {
            command_id: string;
            destination_ids?: string[];
            selection_version?: string;
          };
          return this.destinations[verb](
            args.program_id,
            {
              commandId: body.command_id,
              destinationIds: body.destination_ids,
              selectionVersion: body.selection_version,
              confirmed: true,
            },
            ctx.principal.subject,
          );
        },
      });
    };
    return [
      row(
        'reload',
        'Load destinations into a stopped broadcast',
        'Loads a destination selection into the stopped television executor of a program without going live. Refused with conflict unless the broadcast is stopped. command_id is the replay key: the same id with the same request returns the recorded result.',
        (ids, state) =>
          `Loads ${ids.length} destination(s) into the executor of the program without going live (now ${stateStamp(state)}). Nothing is sent to the destinations until a start.`,
        true,
      ),
      row(
        'start',
        'Start the television broadcast',
        'Starts the television broadcast of a program to the selected destinations: the stream goes out live to every one of them. Every destination must exist and not be retired. command_id is the replay key: the same id with the same request returns the recorded result.',
        (ids, state) =>
          `Starts the television broadcast of the program LIVE to ${ids.length} destination(s): ${ids.join(', ')} (now ${stateStamp(state)}). Viewers of those destinations see the program as soon as the executor acknowledges. Recoverable with destination_stop.`,
        true,
      ),
      row(
        'stop',
        'Stop the television broadcast',
        'Stops the television broadcast of a program: the stream ends for every destination. command_id is the replay key: the same id with the same request returns the recorded result.',
        (_ids, state) =>
          `Stops the television broadcast of the program (now ${stateStamp(state)}): the stream to every destination ends and viewers are cut. Recoverable with destination_start.`,
        true,
      ),
    ];
  }
}
