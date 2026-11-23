import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { MediaService } from '../../media/media.service';
import { ProgramService } from '../../program/program.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { loadUsage, readingImage, scenesNaming, uniq } from './media-usage';
import { programsAffected, whyNot } from './on-air';
import { actionSpec, present, readSpec, rowIdArg } from './support';

const nameArg = z.string().trim().min(1).max(200);
const addressArg = z.string().trim().min(1).max(2000);

interface MediaRow {
  id: number;
  name: string;
  imageUrl: string;
}

const permissions = ALCANTARA_PERMISSIONS.media;

/**
 * gaulatti/alcantara#218: the media (image) capabilities. They call
 * MediaService, the service the console's media routes call, in process.
 *
 * Step 0 of media_remove: the console deletes the image and its media asset
 * after checking only that it exists, takes it out of every media group that
 * holds it (renumbering their items and refreshing the legacy slideshow
 * label), and never looks at what is on air. This capability refuses with
 * on_air while a program that reads a media group holding the image has a
 * scene or fade to black on air, or while a scene on air or staged names the
 * image address in its settings.
 */
@Injectable()
@McpToolProvider()
export class MediaMcpTools {
  constructor(
    private readonly media: MediaService,
    private readonly programs: ProgramService,
  ) {}

  /** The image and which programs read it, through a group or a scene. */
  private async mediaInUse(mediaId: number) {
    const image = (await this.media.findOne(mediaId)) as MediaRow;
    const list = await loadUsage(this.programs);
    const groups = readingImage(list, mediaId);
    const scenes = scenesNaming(list, [image.imageUrl]);
    return {
      image,
      readers: uniq(groups.readers, scenes.readers),
      onAirIn: uniq(groups.onAir, scenes.onAir),
    };
  }

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
      actionSpec({
        name: 'media_create',
        title: 'Create a media image',
        description:
          'Adds an image (a name and an image address) and creates its media asset. It is in no media group until one lists it.',
        permission: permissions.manage,
        tier: 'W',
        shape: { name: nameArg, image_url: addressArg },
        id: () => 'new-media',
        plan: () => ({
          summary:
            'Creates an image and its media asset; it is in no media group until one lists it.',
          affects: [],
          recoverable: true,
        }),
        run: (args) =>
          this.media.create({ name: args.name, imageUrl: args.image_url }),
      }),
      actionSpec({
        name: 'media_update',
        title: 'Update a media image',
        description:
          'Changes the name or image address of an image; a field left out stays. The change shows at once wherever the image is read.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          media_id: rowIdArg,
          name: nameArg.optional(),
          image_url: addressArg.optional(),
        },
        load: (args) => this.mediaInUse(args.media_id),
        id: (args) => String(args.media_id),
        plan: (args, { readers }) => ({
          summary: `Updates image ${args.media_id}. The previous values are not kept: read the image first to restore them. It is read by ${readers.length} program(s).`,
          affects: [
            {
              kind: 'media',
              id: String(args.media_id),
              name: String(args.media_id),
            },
            ...programsAffected(readers),
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args) =>
          this.media.update(
            args.media_id,
            present({ name: args.name, imageUrl: args.image_url }),
          ),
      }),
      actionSpec({
        name: 'media_remove',
        title: 'Delete a media image',
        description:
          'Deletes an image and its media asset and takes it out of every media group that holds it. Refused with on_air while a program that reads a group holding it has a scene or fade to black on air, or a scene on air or staged names its address. Not recoverable. Stricter than the console, which deletes whatever is on air.',
        permission: permissions.manage,
        tier: 'D',
        shape: { media_id: rowIdArg },
        load: (args) => this.mediaInUse(args.media_id),
        id: (args) => String(args.media_id),
        label: (_args, { image }) => image.name,
        plan: (args, { readers, onAirIn }) => ({
          summary: `Deletes image ${args.media_id} and its media asset, and takes it out of every media group that holds it (their items are renumbered). The file in storage stays, but the image, its group places and its label assignments cannot be recovered (a new image gets a new id). It is read by ${readers.length} program(s) (${readers.join(', ')}). The console deletes it even when a live page reads it; this capability refuses while one of them is on air (${onAirIn.length} now).`,
          affects: [
            {
              kind: 'media',
              id: String(args.media_id),
              name: String(args.media_id),
            },
            ...programsAffected(readers),
          ],
          recoverable: false,
        }),
        refuse: (args, { onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `image ${args.media_id} is read by program(s) on air: ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args) => this.media.remove(args.media_id),
      }),
    ];
  }
}
