import { HttpException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { IMPORT_KINDS, UploadsService } from '../../uploads/uploads.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec } from './support';

/**
 * gaulatti/alcantara#218: import_media_from_url (W, upload.create), the audio
 * upload of the console with the file fetched from an address instead of sent
 * as a multipart body.
 *
 * It calls UploadsService.importFromUrl, which fetches under the outbound
 * request policy (https only, public addresses only, each redirect checked
 * again, audio content types, at most 200 MiB, one deadline; counted under
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
@Injectable()
@McpToolProvider()
export class MediaImportMcpTools {
  constructor(private readonly uploads: UploadsService) {}

  specs(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'import_media_from_url',
        title: 'Import audio from a URL',
        description:
          "Fetches an audio file from an https address on the public internet (at most 200 MiB, audio content types only) and stores it as an instant, background or song upload, exactly as the console stores a file it is sent. It answers where the file is stored; it creates no media asset: use the answer's url in song_create or the matching create capability.",
        permission: ALCANTARA_PERMISSIONS.upload.create,
        tier: 'W',
        untrusted: ['coverUrl', 'artist', 'title'],
        shape: {
          url: z.string().trim().min(1).max(2000),
          kind: z.enum(IMPORT_KINDS),
        },
        id: (args) => `import-${args.kind}`,
        plan: (args) => ({
          summary: `Fetches one audio file from the given address (https only, public addresses only, audio content types, at most 200 MiB) and stores it as a ${args.kind} upload. It creates no media asset and nothing changes on air.`,
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
