import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import {
  MediaAssetsService,
  type MediaAssetAuthorization,
} from '../../media-assets/media-assets.service';
import {
  McpToolProvider,
  type McpContext,
  type McpToolSpec,
} from '../contract';
import { readSpec } from './support';

const access = ALCANTARA_PERMISSIONS.access;

/** Asset and label text and addresses were typed or imported by people. */
export const ASSET_UNTRUSTED = ['sourceUrl', 'artist', 'title', 'coverUrl'];

const idArg = z.string().trim().min(1).max(200);

/**
 * What the service decides asset and label access from: the caller's
 * permissions as Pompeii answered for them, as the console's guard hands it.
 */
export const authorizationOf = (ctx: McpContext): MediaAssetAuthorization => ({
  permissions: [...ctx.principal.permissions],
});

/**
 * gaulatti/alcantara#218: the media asset and media label capabilities. They
 * call MediaAssetsService, the service the console's media-assets and
 * media-labels routes call, in process, with the caller's own permissions, so
 * the service's per-asset checks decide as they do in the console.
 */
@Injectable()
@McpToolProvider()
export class MediaAssetsMcpTools {
  constructor(private readonly assets: MediaAssetsService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'media_asset_find_all',
        title: 'List media assets',
        description:
          'Lists the media assets the caller may read, paged as the console pages them (default 50 per page, at most 200), filtered by name, media type, capability (INSTANT, BACKGROUND, SONG, COVER, TRANSITION) or label.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          media_type: z.string().max(50).optional(),
          capability: z.string().max(50).optional(),
          label_id: idArg.optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args, ctx) =>
          this.assets.findAll(
            {
              search: args.search,
              mediaType: args.media_type,
              capability: args.capability,
              labelId: args.label_id,
              page: args.page ?? 1,
              limit: args.limit ?? 50,
            },
            authorizationOf(ctx),
          ),
      }),
      readSpec({
        name: 'media_asset_find_one',
        title: 'Get a media asset',
        description: 'Returns one media asset the caller may read.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: { asset_id: idArg },
        run: (args, ctx) =>
          this.assets.findOne(args.asset_id, authorizationOf(ctx)),
      }),
      readSpec({
        name: 'media_asset_find_labels',
        title: 'List media labels',
        description:
          'Lists media labels with the assets of each that the caller may read, paged as the console pages them (default 50 per page, at most 200).',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args, ctx) =>
          this.assets.findLabels(
            {
              search: args.search,
              page: args.page ?? 1,
              limit: args.limit ?? 50,
            },
            authorizationOf(ctx),
          ),
      }),
      readSpec({
        name: 'media_asset_find_label',
        title: 'Get a media label',
        description:
          'Returns one media label with the assets of it that the caller may read.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: { label_id: idArg },
        run: (args, ctx) =>
          this.assets.findLabel(args.label_id, authorizationOf(ctx)),
      }),
    ];
  }
}
