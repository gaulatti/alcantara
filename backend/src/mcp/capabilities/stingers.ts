import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { StingersService } from '../../stingers/stingers.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.stinger;

/** A stinger's video address was typed or imported by people. */
const STINGER_UNTRUSTED = ['videoUrl'] as const;

/**
 * gaulatti/alcantara#217: the stinger capabilities. They call
 * StingersService, the service the console's stingers routes call, in
 * process.
 */
@Injectable()
@McpToolProvider()
export class StingersMcpTools {
  constructor(private readonly stingers: StingersService) {}

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
    ];
  }
}
