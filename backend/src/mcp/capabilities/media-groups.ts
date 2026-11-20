import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { MediaGroupsService } from '../../media-groups/media-groups.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec } from './support';

/** gaulatti/alcantara#216: the media group capabilities. */
@Injectable()
@McpToolProvider()
export class MediaGroupsMcpTools {
  constructor(private readonly groups: MediaGroupsService) {}

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
          this.groups.findAll({
            search: args.search,
            sortBy: args.sort_by,
            sortOrder: args.sort_order,
            page: args.page ?? 1,
            limit: args.limit ?? 20,
          }),
      }),
    ];
  }
}
