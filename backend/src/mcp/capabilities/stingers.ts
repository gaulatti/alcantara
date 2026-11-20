import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { StingersService } from '../../stingers/stingers.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programsAffected, whyNot } from './on-air';
import { actionSpec, present, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.stinger;

const nameArg = z.string().trim().min(1).max(200);
const addressArg = z.string().trim().min(1).max(2000);
/** The column is an integer; the console sends anything to the database. */
const cutPointArg = z.number().int().min(0);

/** A stinger's video address was typed or imported by people. */
const STINGER_UNTRUSTED = ['videoUrl'] as const;

interface StingerRow {
  id: number;
  name: string;
}

interface ListedWithStingers {
  programId: string;
  activeSceneId: number | null;
  fadeToBlack: boolean;
  stingers: Array<{ stingerId: number }>;
}

/**
 * gaulatti/alcantara#217: the stinger capabilities. They call
 * StingersService, the service the console's stingers routes call, in process.
 *
 * Step 0 of stinger_delete_stinger: the console checks that the stinger exists
 * and deletes it and its media asset in one transaction; its assignments to
 * programs go by cascade. It never looks at what is on air. This capability
 * refuses with on_air while a program the stinger is assigned to has a scene
 * or fade to black on air, because that program's scene changes use its
 * stingers (the same condition program_remove_stinger_from_program refuses on).
 */
@Injectable()
@McpToolProvider()
export class StingersMcpTools {
  constructor(
    private readonly stingers: StingersService,
    private readonly programs: ProgramService,
  ) {}

  /** The stinger and the programs that use it, and those of them on air. */
  private async stingerInUse(stingerId: number) {
    const stinger = (await this.stingers.findOne(stingerId)) as StingerRow;
    const list =
      (await this.programs.listPrograms()) as unknown as ListedWithStingers[];
    const uses = (program: ListedWithStingers) =>
      program.stingers.some((entry) => entry.stingerId === stingerId);
    return {
      stinger,
      assignedTo: list.filter(uses).map((program) => program.programId),
      onAirIn: list
        .filter(
          (program) =>
            uses(program) &&
            (program.activeSceneId !== null || program.fadeToBlack),
        )
        .map((program) => program.programId),
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'stinger_list_stingers',
        title: 'List stingers',
        description:
          'Lists every stinger (a transition video played between scenes) with its cut point, enabled flag and times, newest change first.',
        permission: permissions.read,
        untrusted: STINGER_UNTRUSTED,
        shape: {},
        run: () => this.stingers.findAll(),
      }),
      actionSpec({
        name: 'stinger_create_stinger',
        title: 'Create a stinger',
        description:
          'Adds a stinger (a name and a video address, with an optional cut point in milliseconds, default 1000, and enabled, default true) and creates its media asset. It is used by no program until it is added to one.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: STINGER_UNTRUSTED,
        shape: {
          name: nameArg,
          video_url: addressArg,
          cut_point_ms: cutPointArg.optional(),
          enabled: z.boolean().optional(),
        },
        id: () => 'new-stinger',
        plan: () => ({
          summary:
            'Creates a stinger and its media asset; no program uses it until program_add_stinger_to_program assigns it.',
          affects: [],
          recoverable: true,
        }),
        run: (args) =>
          this.stingers.create({
            name: args.name,
            videoUrl: args.video_url,
            cutPointMs: args.cut_point_ms,
            enabled: args.enabled,
          }),
      }),
      actionSpec({
        name: 'stinger_update_stinger',
        title: 'Update a stinger',
        description:
          'Changes the name, video address, cut point or enabled flag of a stinger; only the fields given change. The next scene change of every program that uses it shows the change.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: STINGER_UNTRUSTED,
        shape: {
          stinger_id: rowIdArg,
          name: nameArg.optional(),
          video_url: addressArg.optional(),
          cut_point_ms: cutPointArg.optional(),
          enabled: z.boolean().optional(),
        },
        load: (args) => this.stingerInUse(args.stinger_id),
        id: (args) => String(args.stinger_id),
        plan: (args, { stinger, assignedTo, onAirIn }) => ({
          summary: `Updates stinger ${args.stinger_id}. The previous values are not kept: read the stinger first to restore them. It is used by ${assignedTo.length} program(s) (${assignedTo.join(', ')}), ${onAirIn.length} of them on air now.`,
          affects: [
            { kind: 'stinger', id: String(stinger.id), name: stinger.name },
            ...programsAffected(assignedTo),
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args) =>
          this.stingers.update(
            args.stinger_id,
            present({
              name: args.name,
              videoUrl: args.video_url,
              cutPointMs: args.cut_point_ms,
              enabled: args.enabled,
            }),
          ),
      }),
      actionSpec({
        name: 'stinger_delete_stinger',
        title: 'Delete a stinger',
        description:
          'Deletes a stinger and its media asset and takes it off every program that uses it; the video file stays in storage. Refused with on_air while a program that uses it has a scene or fade to black on air. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        untrusted: STINGER_UNTRUSTED,
        shape: { stinger_id: rowIdArg },
        load: (args) => this.stingerInUse(args.stinger_id),
        id: (args) => String(args.stinger_id),
        label: (_args, { stinger }) => stinger.name,
        plan: (args, { stinger, assignedTo, onAirIn }) => ({
          summary: `Deletes stinger ${args.stinger_id} with its media asset and takes it off ${assignedTo.length} program(s) (${assignedTo.join(', ')}); the video file stays in storage. Its name, cut point and the places it held in the program stinger lists are lost and cannot be recovered (a new stinger gets a new id and must be added to each program again). The console deletes it whatever is on air; this capability refuses while a program that uses it has a scene or fade to black on air (${onAirIn.length} now), because that program's scene changes use its stingers.`,
          affects: [
            { kind: 'stinger', id: String(stinger.id), name: stinger.name },
            ...programsAffected(assignedTo),
          ],
          recoverable: false,
        }),
        refuse: (args, { onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `stinger ${args.stinger_id} is used by program(s) on air whose scene changes play it: ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args) => this.stingers.remove(args.stinger_id),
      }),
    ];
  }
}
