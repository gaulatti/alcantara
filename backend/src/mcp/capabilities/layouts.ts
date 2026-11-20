import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { LayoutsService } from '../../layouts/layouts.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec, rowIdArg } from './support';

/** gaulatti/alcantara#216: the layout capabilities. */
@Injectable()
@McpToolProvider()
export class LayoutsMcpTools {
  constructor(private readonly layouts: LayoutsService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'layout_find_all',
        title: 'List layouts',
        description: 'Lists every layout by name, as the console loads them.',
        permission: ALCANTARA_PERMISSIONS.layout.read,
        shape: {},
        run: () => this.layouts.findAll(),
      }),
      readSpec({
        name: 'layout_find_one',
        title: 'Get a layout',
        description: 'Reads one layout with the scenes that use it.',
        permission: ALCANTARA_PERMISSIONS.layout.read,
        shape: { layout_id: rowIdArg },
        run: async (args: { layout_id: number }) => {
          const layout = await this.layouts.findOne(args.layout_id);
          if (!layout) throw new McpToolError('not_found', 'Layout not found');
          return layout;
        },
      }),
    ];
  }
}
