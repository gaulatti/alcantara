import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { LayoutsService } from '../../layouts/layouts.service';
import { ProgramService } from '../../program/program.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import {
  listPrograms,
  programIdsWhere,
  programsAffected,
  whyNot,
} from './on-air';
import { actionSpec, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.layout;

const nameArg = z.string().trim().min(1).max(200);
const componentTypeArg = z.string().trim().min(1).max(100);
const settingsArg = z.record(z.string(), z.unknown());

interface LayoutRow {
  id: number;
  name: string;
  scenes: Array<{ id: number }>;
}

/**
 * gaulatti/alcantara#216: the layout capabilities. Step 0 of layout_remove:
 * the console deletes the layout and the database refuses (an unexplained 500)
 * while any scene still uses it; it never looks at what is on air. This
 * capability says so plainly: on_air while a scene of the layout is on air or
 * staged on a program, conflict while any scene still uses it.
 */
@Injectable()
@McpToolProvider()
export class LayoutsMcpTools {
  constructor(
    private readonly layouts: LayoutsService,
    private readonly programs: ProgramService,
  ) {}

  /** The layout with its scenes (not_found when absent) and where they are live. */
  private async layoutInUse(layoutId: number) {
    const layout = (await this.layouts.findOne(layoutId)) as LayoutRow | null;
    if (!layout) throw new McpToolError('not_found', 'Layout not found');
    const sceneIds = layout.scenes.map((scene) => scene.id);
    const listed = await listPrograms(this.programs);
    return {
      layout,
      onAirIn: programIdsWhere(
        listed,
        (p) => p.activeSceneId !== null && sceneIds.includes(p.activeSceneId),
      ),
      stagedIn: programIdsWhere(
        listed,
        (p) => p.stagedSceneId !== null && sceneIds.includes(p.stagedSceneId),
      ),
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'layout_find_all',
        title: 'List layouts',
        description: 'Lists every layout by name, as the console loads them.',
        permission: permissions.read,
        shape: {},
        run: () => this.layouts.findAll(),
      }),
      readSpec({
        name: 'layout_find_one',
        title: 'Get a layout',
        description: 'Reads one layout with the scenes that use it.',
        permission: permissions.read,
        shape: { layout_id: rowIdArg },
        run: async (args) => {
          const layout = await this.layouts.findOne(args.layout_id);
          if (!layout) throw new McpToolError('not_found', 'Layout not found');
          return layout;
        },
      }),
      actionSpec({
        name: 'layout_create',
        title: 'Create a layout',
        description:
          'Creates a layout (a component type with settings); its name must be unique.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          name: nameArg,
          component_type: componentTypeArg,
          settings: settingsArg.optional(),
        },
        id: () => 'new-layout',
        plan: (args) => ({
          summary: `Creates a ${args.component_type} layout; no scene uses it yet.`,
          affects: [],
          recoverable: true,
        }),
        run: (args) =>
          this.layouts.create({
            name: args.name,
            componentType: args.component_type,
            settings: args.settings,
          }),
      }),
      actionSpec({
        name: 'layout_update',
        title: 'Update a layout',
        description:
          'Changes the name, component type or settings of a layout; only the fields given change. Scenes that use it show the change, on air included.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          layout_id: rowIdArg,
          name: nameArg.optional(),
          component_type: componentTypeArg.optional(),
          settings: settingsArg.optional(),
        },
        load: (args) => this.layoutInUse(args.layout_id),
        id: (args) => String(args.layout_id),
        plan: (_args, { layout, onAirIn }) => ({
          summary: `Updates layout ${layout.id}, used by ${layout.scenes.length} scene(s); a scene of it is on air on ${onAirIn.length} program(s) (${onAirIn.join(', ')}). The previous values are not kept: read the layout first to restore them.`,
          affects: [
            { kind: 'layout', id: String(layout.id), name: layout.name },
            ...programsAffected(onAirIn),
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args) =>
          this.layouts.update(args.layout_id, {
            name: args.name,
            componentType: args.component_type,
            settings: args.settings,
          }),
      }),
      actionSpec({
        name: 'layout_remove',
        title: 'Delete a layout',
        description:
          'Deletes a layout nothing uses. Refused with on_air while a scene of it is on air or staged, and with conflict while any scene uses it. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        shape: { layout_id: rowIdArg },
        load: (args) => this.layoutInUse(args.layout_id),
        id: (args) => String(args.layout_id),
        label: (_args, { layout }) => layout.name,
        plan: (_args, { layout, onAirIn, stagedIn }) => ({
          summary: `Deletes layout ${layout.id} with its component type and settings. It cannot be recovered. ${layout.scenes.length} scene(s) use it now and the database refuses the delete while any does; a scene of it is on air on ${onAirIn.length} and staged on ${stagedIn.length} program(s). The console does not look at what is on air; this capability refuses with on_air first.`,
          affects: [
            { kind: 'layout', id: String(layout.id), name: layout.name },
          ],
          recoverable: false,
        }),
        refuse: (_args, { layout, onAirIn, stagedIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `a scene of layout ${layout.id} is on air on ${onAirIn.join(', ')}`,
            ],
            [
              stagedIn.length > 0,
              `a scene of layout ${layout.id} is staged on ${stagedIn.join(', ')}`,
            ],
          ]),
        run: (args, { layout }) => {
          if (layout.scenes.length > 0)
            throw new McpToolError(
              'conflict',
              `Layout ${layout.id} is used by ${layout.scenes.length} scene(s); delete or move them first.`,
            );
          return this.layouts.remove(args.layout_id);
        },
      }),
    ];
  }
}
