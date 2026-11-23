import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import { ArtistLabelsService } from '../../artist-labels/artist-labels.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.media;

/** Artist names were typed or imported by people. */
const ARTIST_UNTRUSTED = ['artist'];

const artistArg = z.string().trim().min(1).max(200);
const labelIdArg = z.string().trim().min(1).max(200).nullable();

/**
 * gaulatti/alcantara#423: the media label attached to an artist, the two capabilities of contract C4
 * (#222). Each calls the service the artist-labels controller calls, in process, for the service's
 * team.
 */
@Injectable()
@McpToolProvider()
export class ArtistLabelsMcpTools {
  constructor(
    private readonly artistLabels: ArtistLabelsService,
    private readonly pompeii: PompeiiService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'media_list_artist_labels',
        title: 'List the artist labels',
        description:
          'Lists the media label attached to each artist: the normalised artist key, the artist as last saved and the label id.',
        permission: permissions.read,
        untrusted: ARTIST_UNTRUSTED,
        shape: {},
        run: () => this.artistLabels.list(this.pompeii.teamId),
      }),
      actionSpec({
        name: 'media_set_artist_label',
        title: 'Attach a media label to an artist',
        description:
          'Attaches a media label to an artist (matched ignoring case and outer spaces), replacing any label already attached, or removes the link when label_id is null. It changes which pictures the artist bumper and the song recipe use for every song by that artist.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: ARTIST_UNTRUSTED,
        shape: { artist: artistArg, label_id: labelIdArg },
        id: (args) => args.artist,
        plan: (args) => ({
          summary:
            args.label_id === null
              ? `Removes the media label attached to "${args.artist}". The previous label is not kept: read the artist labels first to restore it.`
              : `Attaches label ${args.label_id} to "${args.artist}", replacing any label already attached. The previous label is not kept: read the artist labels first to restore it.`,
          affects: [{ kind: 'artist', id: args.artist, name: args.artist }],
          recoverable: true,
        }),
        run: (args) =>
          this.artistLabels.set(
            this.pompeii.teamId,
            args.artist,
            args.label_id,
          ),
      }),
    ];
  }
}
