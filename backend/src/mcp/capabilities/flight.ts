import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { FlightService, START_GRACE_MS } from '../../program/flight.service';
import { ProgramService } from '../../program/program.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { loadProgramLive, whyNot, type ProgramLive } from './on-air';
import {
  actionSpec,
  programIdArg,
  readSpec,
  rowIdArg,
  type Args,
} from './support';

const permissions = ALCANTARA_PERMISSIONS.flight;

const sequenceNameArg = z.string().trim().min(1).max(200);
/**
 * The cues as the console sends them (the service normalizes and validates
 * every one). The bound is the capability's own: a stored outcome is kept in
 * memory, and a clocked log holds at most 120 cues anyway.
 */
const itemsArg = z.array(z.record(z.string(), z.unknown())).max(500);
/** The service accepts only `YYYY-MM-DDTHH:MM:00Z` and says so itself. */
const scheduledAtArg = z.string().max(40).nullable().optional();
/** The log revision the caller read; the service refuses a stale one. */
const revisionArg = z.number().int().min(1);
const labelIdArg = z.string().trim().min(1).max(128);
const artistSeparationArg = z.number().int().min(0).max(20);

/** The rules of `generate`: tagged music blocks and the artist separation. */
const generateRulesArg = z.object({
  slots: z
    .array(
      z.object({
        labelId: labelIdArg,
        count: z.number().int().min(1).max(120),
        clockOffsetSeconds: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(120),
  artistSeparation: artistSeparationArg,
});
/** The rules of `fill`: the filler tag and the artist separation. */
const fillRulesArg = z.object({
  labelId: labelIdArg,
  artistSeparation: artistSeparationArg,
});

/** A flight sequence as the service lists it. */
interface SequenceRow {
  id: number;
  name: string;
  items: unknown[];
  loop: boolean;
  isRunning: boolean;
  activeItemId: string | null;
  scheduledAt: Date | string | null;
  publishedAt: Date | string | null;
  lastStartedAt: Date | string | null;
  revision: number;
}

/** What every flight capability decides from: the program's live state and its sequences. */
interface FlightLive {
  live: ProgramLive;
  sequences: SequenceRow[];
  /** The sequence named in the call, when the capability names one. */
  sequence: SequenceRow | null;
  active: SequenceRow | null;
  /** Changes whenever the program, its active sequence or its position changes. */
  stamp: string;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

/** A published block that has not started and whose start is still to come. */
const isQueued = (sequence: SequenceRow): boolean =>
  sequence.publishedAt !== null &&
  sequence.lastStartedAt === null &&
  sequence.scheduledAt !== null &&
  new Date(sequence.scheduledAt).getTime() >= Date.now() - START_GRACE_MS;

/** The sequence in words, for a plan: ids and counts, never its name or cues. */
function describe(sequence: SequenceRow): string {
  const clocked = sequence.scheduledAt
    ? `clocked for ${iso(sequence.scheduledAt)}, ${sequence.publishedAt ? 'published' : 'a draft'}${
        sequence.lastStartedAt ? ', already started' : ''
      }`
    : sequence.loop
      ? 'not clocked, looping'
      : 'not clocked';
  return `sequence ${sequence.id} (${sequence.items.length} cue(s), ${clocked}, revision ${sequence.revision})`;
}

/**
 * gaulatti/alcantara#215: the flight (rundown) capabilities, the program
 * routes under /program/:programId/flight. Each calls the FlightService
 * method its controller calls, in process, with the caller already
 * authorized by the registry. The confirm name of an operate row is the
 * program's live stamp plus its flight position, so a plan made before the
 * log moved on or the program went on or off air is refused as
 * `confirm_mismatch`.
 *
 * Step 0 of program_delete_flight_sequence_by_id: the console deletes
 * whatever the state of the sequence. A running sequence is stopped and the
 * song playing is cut mid-air; the active pointer is cleared; a published
 * clocked log still waiting for its start is dropped and never airs. This
 * capability refuses with on_air while the sequence is running, is the
 * active sequence, or is published and queued to start.
 */
@Injectable()
@McpToolProvider()
export class FlightMcpTools {
  constructor(
    private readonly flights: FlightService,
    private readonly programs: ProgramService,
  ) {}

  private async load(
    programId: string,
    sequenceId?: number,
  ): Promise<FlightLive> {
    const live = await loadProgramLive(this.programs, programId);
    const sequences = (await this.flights.listFlightSequences(
      programId,
    )) as unknown as SequenceRow[];
    const sequence =
      sequenceId === undefined
        ? null
        : (sequences.find((candidate) => candidate.id === sequenceId) ?? null);
    if (sequenceId !== undefined && !sequence)
      throw new McpToolError('not_found', 'flight sequence not found');
    const active =
      sequences.find(
        (candidate) => candidate.id === live.activeFlightSequenceId,
      ) ?? null;
    const running = sequences.some((candidate) => candidate.isRunning);
    return {
      live,
      sequences,
      sequence,
      active,
      stamp: `${live.stamp} flight:${live.activeFlightSequenceId ?? 'none'} running:${Number(running)} cue:${active?.activeItemId ?? 'none'}`,
    };
  }

  private affects(program: string, sequence: SequenceRow | null) {
    return [
      ...(sequence
        ? [
            {
              kind: 'flight_sequence',
              id: String(sequence.id),
              name: sequence.name,
            },
          ]
        : []),
      { kind: 'program', id: program, name: program },
    ];
  }

  /** A W row on one sequence (or, with no sequence, on the program). */
  private manage<S extends z.ZodRawShape>(row: {
    name: string;
    title: string;
    description: string;
    shape: S;
    summary: (args: Args<S>, loaded: FlightLive) => string;
    recoverable: boolean;
    /** The change shows on air at once. */
    onAir?: (args: Args<S>, loaded: FlightLive) => boolean;
    call: (args: Args<S>) => Promise<unknown>;
  }): McpToolSpec {
    const program = (args: Args<S>) =>
      (args as { program_id: string }).program_id;
    const sequenceOf = (args: Args<S>) =>
      (args as { sequence_id?: number }).sequence_id;
    return actionSpec<S, FlightLive>({
      name: row.name,
      title: row.title,
      description: row.description,
      permission: permissions.manage,
      tier: 'W',
      shape: row.shape,
      load: (args) => this.load(program(args), sequenceOf(args)),
      id: (args) =>
        sequenceOf(args) === undefined
          ? program(args)
          : `${program(args)}/${sequenceOf(args)}`,
      plan: (args, loaded) => ({
        summary: row.summary(args, loaded),
        affects: this.affects(program(args), loaded.sequence),
        recoverable: row.recoverable,
      }),
      onAir: row.onAir,
      run: (args) => row.call(args),
    });
  }

  /** An A row: the flight of one program, confirmed by its live stamp. */
  private operate<S extends z.ZodRawShape>(row: {
    name: string;
    title: string;
    description: string;
    shape: S;
    summary: (args: Args<S>, loaded: FlightLive) => string;
    recoverable: boolean;
    call: (args: Args<S>) => Promise<unknown>;
  }): McpToolSpec {
    const program = (args: Args<S>) =>
      (args as { program_id: string }).program_id;
    const sequenceOf = (args: Args<S>) =>
      (args as { sequence_id?: number }).sequence_id;
    return actionSpec<S, FlightLive>({
      name: row.name,
      title: row.title,
      description: row.description,
      permission: permissions.operate,
      tier: 'A',
      shape: row.shape,
      load: (args) => this.load(program(args), sequenceOf(args)),
      id: program,
      label: (_args, loaded) => loaded.stamp,
      plan: (args, loaded) => ({
        summary: row.summary(args, loaded),
        affects: this.affects(program(args), loaded.sequence ?? loaded.active),
        recoverable: row.recoverable,
      }),
      run: (args) => row.call(args),
    });
  }

  specs(): McpToolSpec[] {
    return [...this.reads(), ...this.writes(), ...this.operations()];
  }

  private reads(): McpToolSpec[] {
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
          'Checks that every song and clip of a clocked log (a sequence with a scheduled start) is available to play; answers `ready`, the `issues` found, and `warnings` that never block a start (a song whose duration is unknown, so later times in the log are estimates). A sequence with no scheduled start is refused as invalid.',
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

  private writes(): McpToolSpec[] {
    return [
      this.manage({
        name: 'program_create_flight_sequence_by_id',
        title: 'Create a flight sequence',
        description:
          'Creates a flight sequence (rundown) on a program from a name and optional cues, loop flag and scheduled start (`scheduled_at` makes it a clocked radio log, which needs a program with a radio leg and cannot loop). Nothing goes on air: activate and start it separately.',
        shape: {
          program_id: programIdArg,
          name: sequenceNameArg,
          items: itemsArg.optional(),
          loop: z.boolean().optional(),
          scheduled_at: scheduledAtArg,
        },
        summary: (args, { live }) =>
          `Creates a ${args.scheduled_at ? 'clocked radio log draft' : 'flight sequence'} with ${args.items?.length ?? 0} cue(s) on program ${args.program_id} (${live.flightSequences} sequence(s) there now). It is not active and does not air until it is activated and started${args.scheduled_at ? ', or published and its start arrives' : ''}. Delete it with program_delete_flight_sequence_by_id.`,
        recoverable: true,
        call: (args) =>
          this.flights.createFlightSequence(args.program_id, {
            name: args.name,
            items: args.items,
            loop: args.loop,
            scheduledAt: args.scheduled_at,
          }),
      }),
      this.manage({
        name: 'program_update_flight_sequence_by_id',
        title: 'Update a flight sequence',
        description:
          'Changes the name, cues, loop flag or scheduled start of a flight sequence; only the fields given change. A clocked log needs the `revision` you read, and a stale one is refused as conflict. A running log can only change cues after the one on air.',
        shape: {
          program_id: programIdArg,
          sequence_id: rowIdArg,
          name: sequenceNameArg.optional(),
          items: itemsArg.optional(),
          loop: z.boolean().optional(),
          scheduled_at: scheduledAtArg,
          revision: revisionArg.optional(),
        },
        summary: (args, { sequence }) =>
          `Changes ${
            [
              args.name !== undefined && 'the name',
              args.items !== undefined && `the cues (to ${args.items.length})`,
              args.loop !== undefined && 'the loop flag',
              args.scheduled_at !== undefined && 'the scheduled start',
            ]
              .filter(Boolean)
              .join(', ') || 'nothing'
          } of ${describe(sequence!)}. ${
            sequence!.isRunning
              ? 'It is running on air: the console refuses schedule and loop changes and any edit of the cue on air or already played; later cues change at once.'
              : ''
          } The previous values are not kept: read the sequence first to restore them.`,
        recoverable: true,
        onAir: (_args, { sequence }) => sequence!.isRunning,
        call: (args) =>
          this.flights.updateFlightSequence(args.program_id, args.sequence_id, {
            name: args.name,
            items: args.items,
            loop: args.loop,
            scheduledAt: args.scheduled_at,
            revision: args.revision,
          }),
      }),
      this.manage({
        name: 'program_generate_tagged_log',
        title: 'Propose a radio log from tagged music blocks',
        description:
          'Builds a proposed list of cues for an unaired, unpublished clocked log from tagged music blocks and an artist separation, and returns it; nothing is saved (save it with program_update_flight_sequence_by_id). Needs the `revision` you read; a stale one is refused as conflict.',
        shape: {
          program_id: programIdArg,
          sequence_id: rowIdArg,
          revision: revisionArg,
          rules: generateRulesArg,
        },
        summary: (args, { sequence }) =>
          `Proposes cues for ${describe(sequence!)} from ${args.rules.slots.length} tagged block(s), and returns them. Nothing is saved or aired. The console refuses a log that is not an unaired, unpublished draft of a program with a radio leg.`,
        recoverable: true,
        call: (args) =>
          this.flights.generateTaggedLog(args.program_id, args.sequence_id, {
            revision: args.revision,
            rules: args.rules,
          }),
      }),
      this.manage({
        name: 'program_fill_rundown',
        title: 'Propose filler for the gaps of a rundown',
        description:
          'Fills the gaps between the timed content of an unaired, unpublished clocked rundown with songs of a filler tag, and returns the proposed cues and warnings; nothing is saved. Needs the `revision` you read; a stale one is refused as conflict.',
        shape: {
          program_id: programIdArg,
          sequence_id: rowIdArg,
          revision: revisionArg,
          rules: fillRulesArg,
          items: itemsArg,
        },
        summary: (args, { sequence }) =>
          `Proposes filler for the gaps of the ${args.items.length} cue(s) given for ${describe(sequence!)}, and returns the filled list with warnings. Nothing is saved or aired. The console refuses a rundown that is not an unaired, unpublished draft of a program with a radio leg.`,
        recoverable: true,
        call: (args) =>
          this.flights.fillRundown(args.program_id, args.sequence_id, {
            revision: args.revision,
            rules: args.rules,
            items: args.items,
          }),
      }),
      this.manage({
        name: 'program_publish_flight_sequence_by_id',
        title: 'Publish a clocked log',
        description:
          'Publishes a clocked radio log: the console then starts it by itself at its scheduled time, and its scheduled start can no longer change. The start must be in the future, the log must pass preflight, and `revision` must be the one you read.',
        shape: {
          program_id: programIdArg,
          sequence_id: rowIdArg,
          revision: revisionArg,
        },
        summary: (_args, { sequence }) =>
          `Publishes ${describe(sequence!)}. From then on it starts on air by itself at its scheduled time, with nobody present, and its start cannot be moved. There is no unpublish: the only way back is program_delete_flight_sequence_by_id (refused while it is queued to air) or editing its cues. The console refuses a start that is not in the future, a looping log and a log that fails preflight.`,
        recoverable: false,
        call: (args) =>
          this.flights.publishFlightSequence(
            args.program_id,
            args.sequence_id,
            args.revision,
          ),
      }),
      actionSpec({
        name: 'program_delete_flight_sequence_by_id',
        title: 'Delete a flight sequence',
        description:
          'Deletes a flight sequence and its cues. Refused with on_air while the sequence is running, is the active sequence of the program, or is a published log queued to start. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        shape: { program_id: programIdArg, sequence_id: rowIdArg },
        load: (args) => this.load(args.program_id, args.sequence_id),
        id: (args) => `${args.program_id}/${args.sequence_id}`,
        label: (_args, { sequence }) => sequence!.name,
        plan: (args, { sequence }) => ({
          summary: `Deletes ${describe(sequence!)} of program ${args.program_id}. Lost: its cues and their order, its schedule and its published state; the songs, scenes and clips the cues point to stay. It cannot be recovered: there is no copy and no unpublish, so read it first with program_list_flight_sequences_by_id and recreate it by hand. The console deletes it whatever its state (a running sequence is stopped and the song playing is cut, an active one is deactivated, a published log waiting for its start never airs); this capability refuses while it is running, active or queued.`,
          affects: this.affects(args.program_id, sequence),
          recoverable: false,
        }),
        refuse: (args, { sequence, live }) =>
          whyNot([
            [
              sequence!.isRunning,
              `flight sequence ${sequence!.id} is running on ${args.program_id}`,
            ],
            [
              live.activeFlightSequenceId === sequence!.id,
              `flight sequence ${sequence!.id} is the active sequence of ${args.program_id}`,
            ],
            [
              isQueued(sequence!),
              `flight sequence ${sequence!.id} is published and queued to start at ${
                sequence!.scheduledAt ? iso(sequence!.scheduledAt) : 'its time'
              }`,
            ],
          ]),
        run: (args) =>
          this.flights.deleteFlightSequence(args.program_id, args.sequence_id),
      }),
    ];
  }

  private operations(): McpToolSpec[] {
    const program = { program_id: programIdArg };
    const position = (live: FlightLive) =>
      live.active
        ? `active sequence ${live.active.id}${live.active.isRunning ? ` (running, cue ${live.active.activeItemId ?? 'none'})` : ' (stopped)'}`
        : 'no active sequence';
    return [
      this.operate({
        name: 'program_activate_flight_sequence_by_id',
        title: 'Make a flight sequence the active one',
        description:
          'Makes a sequence the active flight sequence of a program. A running flight stops and the song playing is cut; a sequence that is not clocked always does this. Nothing starts until start or go. A clocked log must be published and pass preflight.',
        shape: { ...program, sequence_id: rowIdArg },
        summary: (args, loaded) =>
          `Makes ${describe(loaded.sequence!)} the active sequence of program ${args.program_id} (now: ${position(loaded)}). A running flight stops and the song playing is cut, with the rotation left manual; the cut song does not come back. Nothing starts yet. Live now: ${loaded.live.liveText}.`,
        recoverable: true,
        call: (args) =>
          this.flights.activateFlightSequence(
            args.program_id,
            args.sequence_id,
          ),
      }),
      this.operate({
        name: 'program_deactivate_flight_sequence_by_id',
        title: 'Deactivate the flight sequence of a program',
        description:
          'Stops the running flight, cuts the song playing and clears the active flight sequence of a program.',
        shape: program,
        summary: (args, loaded) =>
          `Stops the flight of program ${args.program_id} (${position(loaded)}), cuts the song playing and clears the active sequence. The cut song does not come back. Live now: ${loaded.live.liveText}.`,
        recoverable: true,
        call: (args) => this.flights.deactivateFlightSequence(args.program_id),
      }),
      this.operate({
        name: 'program_start_flight_by_id',
        title: 'Start the active flight sequence',
        description:
          'Starts the active flight sequence of a program from its first cue; a flight already running is stopped (and the song playing cut) and starts over. A clocked log must be published and pass preflight.',
        shape: program,
        summary: (args, loaded) =>
          `Starts the flight of program ${args.program_id} from cue 1 (${position(loaded)}); a running flight stops first and the song playing is cut. Its cues then act on air by themselves (scenes, songs, clips, mixer). Live now: ${loaded.live.liveText}.`,
        recoverable: false,
        call: (args) => this.flights.start(args.program_id),
      }),
      this.operate({
        name: 'program_stop_flight_by_id',
        title: 'Stop the flight of a program',
        description:
          'Stops the running flight of a program and cuts the song playing; the active sequence stays active.',
        shape: program,
        summary: (args, loaded) =>
          `Stops the flight of program ${args.program_id} (${position(loaded)}) and cuts the song playing, turning the rotation to manual; the cut song does not come back, and starting again begins at cue 1. Live now: ${loaded.live.liveText}.`,
        recoverable: false,
        call: (args) => this.flights.stop(args.program_id),
      }),
      this.operate({
        name: 'program_go_flight_by_id',
        title: 'Advance the flight to the next cue',
        description:
          'Runs the next cue of the running flight of a program at once (or, when no flight is running, starts the active sequence). A clocked log cannot advance before its scheduled start.',
        shape: program,
        summary: (args, loaded) =>
          `Runs the next cue of program ${args.program_id} now (${position(loaded)}); with no flight running it starts the active sequence from cue 1. The cue acts on air at once and cannot be taken back. Live now: ${loaded.live.liveText}.`,
        recoverable: false,
        call: (args) => this.flights.go(args.program_id),
      }),
      this.operate({
        name: 'program_reset_flight_by_id',
        title: 'Reset the flight of a program',
        description:
          'Stops the flight of a program, cuts the song playing and clears its position; a flight that was running starts again from its first cue.',
        shape: program,
        summary: (args, loaded) =>
          `Resets the flight of program ${args.program_id} (${position(loaded)}): it stops, the song playing is cut and the position clears; if it was running it starts again from cue 1. Live now: ${loaded.live.liveText}.`,
        recoverable: false,
        call: (args) => this.flights.reset(args.program_id),
      }),
    ];
  }
}
