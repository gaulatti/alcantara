import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { RadioClocksService } from '../../program/radio-clocks.service';
import { RadioDaypartPlanner } from '../../program/radio-daypart-planner.service';
import { RadioDaypartsService } from '../../program/radio-dayparts.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.flight;
const revisionArg = z.number().int().min(1);
const clockNameArg = z.string().trim().min(1).max(100);
const rulesArg = z.object({
  slots: z
    .array(
      z.object({
        labelId: z.string().trim().min(1).max(128),
        count: z.number().int().min(1).max(120),
        clockOffsetSeconds: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(120),
  artistSeparation: z.number().int().min(0).max(20),
});
const daypartArg = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  clockId: rowIdArg,
  start: z.enum(['soft', 'hard']).optional(),
});

/**
 * gaulatti/alcantara#124: radio clocks and the weekly daypart grid for MCP clients. Reads list them and preview the
 * coming hours; writes change them through the services the console uses, behind a dry run.
 */
@Injectable()
@McpToolProvider()
export class DaypartMcpTools {
  constructor(
    private readonly clocks: RadioClocksService,
    private readonly dayparts: RadioDaypartsService,
    private readonly planner: RadioDaypartPlanner,
  ) {}

  private async clock(programId: string, clockId: number) {
    const found = (await this.clocks.list(programId)).find(
      (candidate) => candidate.id === clockId,
    );
    if (!found) throw new McpToolError('not_found', 'clock not found');
    return found;
  }

  specs(): McpToolSpec[] {
    const program = (id: string) => [{ kind: 'program', id, name: id }];
    return [
      readSpec({
        name: 'program_list_radio_clocks_by_id',
        title: 'List the radio clocks of a program',
        description:
          'Lists the clocks of a radio program: name, revision and radio log rules, the tagged music blocks one hour made from it holds (GET /program/:programId/radio-clocks).',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        untrusted: ['name'],
        run: (args) => this.clocks.list(args.program_id),
      }),
      readSpec({
        name: 'program_get_radio_dayparts_by_id',
        title: 'Read the weekly daypart grid of a program',
        description:
          'Reads the weekly grid of a radio program: its time zone, revision and dayparts, each a day (0 = Sunday), the hours [startHour, endHour), a clock and a start of soft (after the song on air) or hard (GET /program/:programId/radio-dayparts). An empty grid means nothing is generated.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.dayparts.get(args.program_id),
      }),
      readSpec({
        name: 'program_preview_radio_dayparts_by_id',
        title: 'Preview the coming hours of the daypart grid',
        description:
          'For each hour of the grid beginning in the next `hours` (default 2): the log already made for it, or the cues its clock would give it now, or why it cannot be filled. Writes nothing. Unmade hours are proposed one by one, so the songs can differ when the hour is made.',
        permission: permissions.read,
        shape: {
          program_id: programIdArg,
          hours: z.number().int().min(1).max(24).optional(),
        },
        untrusted: ['name', 'items', 'problem'],
        run: async (args) => {
          // Refuses a program that is missing or has no radio leg, as the grid read does.
          await this.dayparts.get(args.program_id);
          return this.planner.preview(args.program_id, args.hours ?? 2);
        },
      }),
      actionSpec({
        name: 'program_create_radio_clock_by_id',
        title: 'Create a radio clock',
        description:
          'Creates a clock on a radio program. Nothing airs because a clock exists: only hours the daypart grid gives it are filled.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          name: clockNameArg,
          rules: rulesArg,
        },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Creates a clock of ${args.rules.slots.length} tagged block(s) on program ${args.program_id}. It fills no hour until the daypart grid names it.`,
          affects: program(args.program_id),
          recoverable: true,
        }),
        run: (args) =>
          this.clocks.create(args.program_id, {
            name: args.name,
            rules: args.rules,
          }),
      }),
      actionSpec({
        name: 'program_update_radio_clock_by_id',
        title: 'Change a radio clock',
        description:
          'Changes the name or rules of a clock read at `revision` (a stale one is a conflict). Hours already made keep their songs.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          clock_id: rowIdArg,
          revision: revisionArg,
          name: clockNameArg.optional(),
          rules: rulesArg.optional(),
        },
        load: (args) => this.clock(args.program_id, args.clock_id),
        id: (args) => `${args.program_id}/clock/${args.clock_id}`,
        plan: (args, clock) => ({
          summary: `Changes clock ${args.clock_id} (revision ${clock.revision}) of program ${args.program_id}. Hours made from now on use it; hours already made keep their songs.`,
          affects: program(args.program_id),
          recoverable: true,
        }),
        run: (args) =>
          this.clocks.update(args.program_id, args.clock_id, {
            revision: args.revision,
            name: args.name,
            rules: args.rules,
          }),
      }),
      actionSpec({
        name: 'program_delete_radio_clock_by_id',
        title: 'Delete a radio clock',
        description:
          'Deletes a clock read at `revision`. Refused while a daypart uses it. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        shape: {
          program_id: programIdArg,
          clock_id: rowIdArg,
          revision: revisionArg,
        },
        load: (args) => this.clock(args.program_id, args.clock_id),
        id: (args) => `${args.program_id}/clock/${args.clock_id}`,
        label: (_args, clock) => clock.name,
        plan: (args, clock) => ({
          summary: `Deletes clock ${args.clock_id} (revision ${clock.revision}) of program ${args.program_id}. Its rules cannot be recovered. Refused while a daypart uses it.`,
          affects: program(args.program_id),
          recoverable: false,
        }),
        run: (args) =>
          this.clocks.delete(args.program_id, args.clock_id, args.revision),
      }),
      actionSpec({
        name: 'program_set_radio_dayparts_by_id',
        title: 'Save the weekly daypart grid',
        description:
          'Replaces the whole weekly grid of a radio program, at the `revision` read (0 for a first save). From then on the hours it names are filled from their clocks up to two hours ahead and published, and start by themselves while the rotation is Autoplay or Shuffle. An empty list stops that. Logs made by a person are never changed.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          revision: z.number().int().min(0),
          time_zone: z.string().trim().min(1).max(64),
          dayparts: z.array(daypartArg).max(168),
        },
        load: (args) =>
          this.dayparts.check(args.program_id, {
            revision: args.revision,
            timeZone: args.time_zone,
            dayparts: args.dayparts,
          }),
        id: (args) => `${args.program_id}/dayparts`,
        plan: (args, grid) => ({
          summary: grid.dayparts.length
            ? `Saves ${grid.dayparts.length} daypart(s) in ${grid.timeZone} for program ${args.program_id}. Their hours are filled from their clocks, published up to two hours ahead and start by themselves while the rotation is Autoplay or Shuffle.`
            : `Saves an empty grid for program ${args.program_id}: no hour is made from a clock, and untouched coming ones are removed.`,
          affects: program(args.program_id),
          recoverable: true,
        }),
        run: (args) =>
          this.dayparts.save(args.program_id, {
            revision: args.revision,
            timeZone: args.time_zone,
            dayparts: args.dayparts,
          }),
      }),
    ];
  }
}
