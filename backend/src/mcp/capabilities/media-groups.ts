import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import { MediaGroupsService } from '../../media-groups/media-groups.service';
import { ProgramService } from '../../program/program.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import {
  listPrograms,
  programIdsWhere,
  programsAffected,
  whyNot,
} from './on-air';
import { actionSpec, present, readSpec, rowIdArg } from './support';

const manage = ALCANTARA_PERMISSIONS.media.manage;

const nameArg = z.string().trim().min(1).max(200);
const descriptionArg = z.string().max(2000).nullable().optional();
const mediaIdsArg = z.array(rowIdArg).max(500);

interface GroupAnswer {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{ mediaId: number }>;
}

/**
 * A write answers with the group's ids and times and its text (isolated under
 * `untrusted` like every answer), not with every media row of the group (a stored outcome is
 * kept whole in memory); media_group_find_all lists the items.
 */
function groupSummary(raw: unknown) {
  const group = raw as GroupAnswer;
  return {
    id: group.id,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    mediaIds: group.items.map((item) => item.mediaId),
    name: group.name,
    description: group.description,
  };
}

/**
 * gaulatti/alcantara#216: the media group capabilities. Step 0 of
 * media_group_remove: the console deletes the group, its items and its
 * program assignments (and the legacy label that mirrors it) whatever is on
 * air; the media themselves stay. This capability refuses with on_air while a
 * program the group is assigned to has a scene or fade to black on air,
 * because that program's live page reads its groups.
 */
@Injectable()
@McpToolProvider()
export class MediaGroupsMcpTools {
  constructor(
    private readonly groups: MediaGroupsService,
    private readonly programs: ProgramService,
    private readonly pompeii: PompeiiService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'media_group_find_all',
        title: 'List media groups',
        description:
          'Lists media groups with their ordered media, paged as the console pages them (default 20 per page, at most 100).',
        permission: ALCANTARA_PERMISSIONS.media.read,
        shape: {
          search: z.string().max(200).optional(),
          sort_by: z.enum(['id', 'name', 'updatedAt', 'createdAt']).optional(),
          sort_order: z.enum(['asc', 'desc']).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        run: (args) =>
          this.groups.findAll(
            {
              search: args.search,
              sortBy: args.sort_by,
              sortOrder: args.sort_order,
              page: args.page ?? 1,
              limit: args.limit ?? 20,
            },
            this.pompeii.teamId,
          ),
      }),
      actionSpec({
        name: 'media_group_create',
        title: 'Create a media group',
        description:
          'Creates a media group (a unique name, an optional description and an ordered list of existing media). The answer lists the media ids, not the media.',
        permission: manage,
        tier: 'W',
        shape: {
          name: nameArg,
          description: descriptionArg,
          media_ids: mediaIdsArg.optional(),
        },
        id: () => 'new-media-group',
        plan: (args) => ({
          summary: `Creates a media group of ${args.media_ids?.length ?? 0} media; it is on no program until it is added to one.`,
          affects: [],
          recoverable: true,
        }),
        run: (args) =>
          this.groups.create(
            {
              name: args.name,
              description: args.description,
              mediaIds: args.media_ids,
            },
            this.pompeii.teamId,
          ),
        result: groupSummary,
      }),
      actionSpec({
        name: 'media_group_update',
        title: 'Update a media group',
        description:
          'Changes the name, description or ordered media of a media group; only the fields given change, and media_ids replaces the whole list. The answer lists the media ids, not the media.',
        permission: manage,
        tier: 'W',
        shape: {
          media_group_id: rowIdArg,
          name: nameArg.optional(),
          description: descriptionArg,
          media_ids: mediaIdsArg.optional(),
        },
        id: (args) => String(args.media_group_id),
        plan: (args) => ({
          summary: `Updates media group ${args.media_group_id}. The previous values are not kept: read the group first to restore them.`,
          affects: [
            {
              kind: 'media_group',
              id: String(args.media_group_id),
              name: String(args.media_group_id),
            },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.groups.update(
            args.media_group_id,
            present({
              name: args.name,
              description: args.description,
              mediaIds: args.media_ids,
            }),
            this.pompeii.teamId,
          ),
        result: groupSummary,
      }),
      actionSpec({
        name: 'media_group_remove',
        title: 'Delete a media group',
        description:
          'Deletes a media group, its item list and its program assignments (the media stay). Refused with on_air while a program it is assigned to has a scene or fade to black on air. Not recoverable.',
        permission: manage,
        tier: 'D',
        shape: { media_group_id: rowIdArg },
        load: async (args) => {
          const group = (await this.groups.findOne(
            args.media_group_id,
            this.pompeii.teamId,
          )) as GroupAnswer;
          const listed = await listPrograms(this.programs);
          const uses = (p: { mediaGroups: Array<{ mediaGroupId: number }> }) =>
            p.mediaGroups.some((entry) => entry.mediaGroupId === group.id);
          return {
            group,
            assignedTo: programIdsWhere(listed, uses),
            onAirIn: programIdsWhere(
              listed,
              (p) => uses(p) && (p.activeSceneId !== null || p.fadeToBlack),
            ),
          };
        },
        id: (args) => String(args.media_group_id),
        label: (_args, { group }) => group.name,
        plan: (_args, { group, assignedTo, onAirIn }) => ({
          summary: `Deletes media group ${group.id} with its list of ${group.items.length} media and its assignment to ${assignedTo.length} program(s) (${assignedTo.join(', ')}). The media stay; the grouping, its order and the assignments are lost and cannot be recovered (a new group of the same media gets a new id). The console deletes it even when a live page reads it; this capability refuses while a program it is assigned to is on air (${onAirIn.length} now).`,
          affects: [
            { kind: 'media_group', id: String(group.id), name: group.name },
            ...programsAffected(assignedTo),
          ],
          recoverable: false,
        }),
        refuse: (_args, { group, onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `media group ${group.id} is read by program(s) on air: ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args) =>
          this.groups.remove(args.media_group_id, this.pompeii.teamId),
      }),
    ];
  }
}
