import { HttpException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { IMPORT_KINDS, UploadsService } from '../../uploads/uploads.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec } from './support';

/**
 * gaulatti/alcantara#218 and #226: import_media_from_url (W, upload.create),
 * the five uploads of the console (instant, background, song, artwork and
 * stinger) with the file fetched from an address instead of sent as a
 * multipart body.
 *
 * It calls UploadsService.importFromUrl, which fetches under the outbound
 * request policy (https only, public addresses only, each redirect checked
 * again, the content type and size limit of the kind, one deadline; counted under
 * alcantara_outbound_fetch_total{path="media_import"}) and then stores the
 * bytes through the same upload() the console's audio uploads use.
 *
 * The address is never logged or echoed and only its sanitised file name is
 * kept, as for a sent file: the audit target is a fixed word, the plan and the answer carry no address, and a refusal is the
 * policy's plain message.
 *
 * Like an upload, an import creates no media asset and schedules no analysis:
 * it answers where the file is (key, url, bucket, content type, size and, for
 * a song, the metadata read from its tags), and a later song_create or an
 * Instant or background creation, which creates the asset, uses that url.
 */
/** What each kind accepts, in words: the upload route's own type and size limits. */
const KIND_LIMITS: Record<(typeof IMPORT_KINDS)[number], string> = {
  instant: 'audio content types, at most 200 MiB',
  background: 'audio content types, at most 200 MiB',
  song: 'audio content types, at most 200 MiB',
  artwork: 'an image content type, at most 10 MiB',
  stinger: 'video/webm, at most 50 MiB',
};

@Injectable()
@McpToolProvider()
export class MediaImportMcpTools {
  constructor(private readonly uploads: UploadsService) {}

  specs(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'import_media_from_url',
        title: 'Import media from a URL',
        description:
          "Fetches a file from an https address on the public internet and stores it as an instant, background, song, artwork or stinger upload, exactly as the console stores a file it is sent: instant, background and song take audio content types (at most 200 MiB), artwork an image (avif, gif, jpeg, png or webp, at most 10 MiB) and stinger a video/webm (at most 50 MiB). It answers where the file is stored; it creates no media asset: use the answer's url in song_create or the matching create capability.",
        permission: ALCANTARA_PERMISSIONS.upload.create,
        tier: 'W',
        untrusted: ['coverUrl', 'artist', 'title'],
        shape: {
          url: z.string().trim().min(1).max(2000),
          kind: z.enum(IMPORT_KINDS),
        },
        id: (args) => `import-${args.kind}`,
        plan: (args) => ({
          summary: `Fetches one file from the given address (https only, public addresses only, ${KIND_LIMITS[args.kind]}) and stores it as a ${args.kind} upload. It creates no media asset and nothing changes on air.`,
          affects: [],
          recoverable: true,
        }),
        run: async (args) => {
          try {
            return await this.uploads.importFromUrl({
              kind: args.kind,
              url: args.url,
            });
          } catch (error) {
            // The policy's 502 and 504 and a failed store are not the caller's fault.
            if (error instanceof HttpException && error.getStatus() >= 500)
              throw new McpToolError('unavailable', error.message);
            throw error;
          }
        },
      }),
    ];
  }
}
