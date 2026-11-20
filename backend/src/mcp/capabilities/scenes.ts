import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ScenesService } from '../../scenes/scenes.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec, rowIdArg } from './support';

/** gaulatti/alcantara#216: the scene capabilities. */
@Injectable()
@McpToolProvider()
export class ScenesMcpTools {
  constructor(private readonly scenes: ScenesService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'scene_find_all',
        title: 'List scenes',
        description:
          'Lists every scene with its layout, newest first, as the console loads them.',
        permission: ALCANTARA_PERMISSIONS.scene.read,
        shape: {},
        run: () => this.scenes.findAll(),
      }),
      readSpec({
        name: 'scene_find_one',
        title: 'Get a scene',
        description: 'Reads one scene with its layout.',
        permission: ALCANTARA_PERMISSIONS.scene.read,
        shape: { scene_id: rowIdArg },
        run: async (args: { scene_id: number }) => {
          const scene = await this.scenes.findOne(args.scene_id);
          if (!scene) throw new McpToolError('not_found', 'Scene not found');
          return scene;
        },
      }),
    ];
  }
}
