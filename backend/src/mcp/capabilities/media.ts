import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { MediaService } from '../../media/media.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.media;

/**
 * gaulatti/alcantara#218: the media (image) capabilities. They call
 * MediaService, the service the console's media routes call, in process.
 */
@Injectable()
@McpToolProvider()
export class MediaMcpTools {
  constructor(private readonly media: MediaService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'media_find_all',
        title: 'List media',
        description:
          'Lists images, paged as the console pages them (default 50 per page, at most 200).',
        permission: permissions.read,
        shape: {
          search: z.string().max(200).optional(),
          sort_by: z.enum(['id', 'name', 'updatedAt', 'createdAt']).optional(),
          sort_order: z.enum(['asc', 'desc']).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args) =>
          this.media.findAll({
            search: args.search,
            sortBy: args.sort_by,
            sortOrder: args.sort_order,
            page: args.page ?? 1,
            limit: args.limit ?? 50,
          }),
      }),
      readSpec({
        name: 'media_find_one',
        title: 'Get a media image',
        description: 'Returns one image by its id.',
        permission: permissions.read,
        shape: { media_id: rowIdArg },
        run: (args) => this.media.findOne(args.media_id),
      }),
    ];
  }
}
