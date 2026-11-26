import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { SongsService } from '../../songs/songs.service';
import { PompeiiService } from '../../auth/pompeii.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import {
  loadUsage,
  playingIn,
  queuedIn,
  sequencedIn,
  uniq,
} from './media-usage';
import { programsAffected, whyNot } from './on-air';
import { actionSpec, present, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.song;

/** Song text and addresses were typed or imported by people. */
export const SONG_UNTRUSTED = [
  'artist',
  'title',
  'audioUrl',
  'coverUrl',
  'sourceUrl',
] as const;

const programIdArg = z.string().trim().min(1).max(100);

const textArg = z.string().max(500);
const addressArg = z.string().trim().min(1).max(2000);
const chartValueArg = z.union([z.string().max(100), z.number()]).nullable();

/** The fields of a song the console's create and update routes accept. */
const songFields = {
  artist: textArg.optional(),
  title: textArg.optional(),
  cover_url: z.string().max(2000).nullable().optional(),
  duration_ms: z.number().positive().nullable().optional(),
  external_chart_id: chartValueArg.optional(),
  external_chart_rank: chartValueArg.optional(),
  external_chart_spins: chartValueArg.optional(),
  external_chart_provider: z.string().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
  program_id: programIdArg.optional(),
  intro_instant_id: rowIdArg.nullable().optional(),
};

type SongFields = z.infer<z.ZodObject<typeof songFields>>;

const songInput = (args: SongFields & { audio_url?: string }) =>
  present({
    artist: args.artist,
    title: args.title,
    audioUrl: args.audio_url,
    coverUrl: args.cover_url,
    durationMs: args.duration_ms,
    externalChartId: args.external_chart_id,
    externalChartRank: args.external_chart_rank,
    externalChartSpins: args.external_chart_spins,
    externalChartProvider: args.external_chart_provider,
    enabled: args.enabled,
    programId: args.program_id,
    introInstantId: args.intro_instant_id,
  });

interface SongRow {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
}

/**
 * gaulatti/alcantara#218: the song capabilities. They call SongsService, the
 * service the console's songs routes call, in process.
 *
 * Step 0 of song_remove: the console deletes the song, its media asset, its
 * cover link, its chart identity, its intro assignment and its embeddings
 * (all in one transaction or by cascade) after checking only that it exists;
 * it never looks at what is playing, queued or in a program's song sequence.
 * This capability refuses with on_air while a program is playing the song,
 * holds it in the Play Next queue, or lists it in its song sequence.
 */
@Injectable()
@McpToolProvider()
export class SongsMcpTools {
  constructor(
    private readonly songs: SongsService,
    private readonly programs: ProgramService,
    private readonly pompeii: PompeiiService,
  ) {}

  /** The song and where it is playing, queued or sequenced. */
  private async songInUse(songId: number) {
    const song = (await this.songs.findOne(
      songId,
      undefined,
      this.pompeii.teamId,
    )) as SongRow;
    const list = await loadUsage(this.programs);
    return {
      song,
      playing: await playingIn(this.programs, list, song.audioUrl),
      queued: queuedIn(list, songId),
      sequenced: sequencedIn(list, songId),
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'song_find_all',
        title: 'List songs',
        description:
          'Lists the song catalog, paged as the console pages it (default 50 per page; at most 200, where the console also accepts 0 for the whole catalog). program_id selects whose intro Instant is shown (default main).',
        permission: permissions.read,
        untrusted: SONG_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          enabled: z.boolean().optional(),
          sort_by: z
            .enum([
              'id',
              'artist',
              'title',
              'durationMs',
              'updatedAt',
              'createdAt',
              'enabled',
            ])
            .optional(),
          sort_order: z.enum(['asc', 'desc']).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          program_id: programIdArg.optional(),
        },
        run: (args) =>
          this.songs.findAll(
            {
              search: args.search,
              enabled: args.enabled,
              sortBy: args.sort_by,
              sortOrder: args.sort_order,
              page: args.page ?? 1,
              limit: args.limit ?? 50,
              programId: args.program_id,
            },
            this.pompeii.teamId,
          ),
      }),
      readSpec({
        name: 'song_find_one',
        title: 'Get a song',
        description:
          "Returns one song with its intro Instant for a program (default main). The song's audio analysis is not part of this answer.",
        permission: permissions.read,
        untrusted: SONG_UNTRUSTED,
        shape: { song_id: rowIdArg, program_id: programIdArg.optional() },
        run: (args) =>
          this.songs.findOne(
            args.song_id,
            args.program_id,
            this.pompeii.teamId,
          ),
      }),
      actionSpec({
        name: 'song_create',
        title: 'Create a song',
        description:
          'Adds a song to the catalog (artist or title, and an audio address) and creates its media asset; an intro Instant may be set for a program (default main). The song is in no rotation until a sequence uses it.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: SONG_UNTRUSTED,
        shape: { ...songFields, audio_url: addressArg },
        id: () => 'new-song',
        plan: () => ({
          summary:
            'Creates a song and its media asset in the catalog; it is in no rotation until a program song sequence lists it.',
          affects: [],
          recoverable: true,
        }),
        run: (args) => this.songs.create(songInput(args), this.pompeii.teamId),
      }),
      actionSpec({
        name: 'song_update',
        title: 'Update a song',
        description:
          'Changes the given fields of a song; a field left out stays, null clears cover_url, duration, the chart values and the intro. The change shows at once wherever the song is read.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: SONG_UNTRUSTED,
        shape: {
          song_id: rowIdArg,
          ...songFields,
          audio_url: addressArg.optional(),
        },
        load: (args) => this.songInUse(args.song_id),
        id: (args) => String(args.song_id),
        plan: (args, { playing, queued, sequenced }) => ({
          summary: `Updates song ${args.song_id}. The previous values are not kept: read the song first to restore them. It is playing on ${playing.length} program(s), queued on ${queued.length} and in the song sequence of ${sequenced.length}.`,
          affects: [
            {
              kind: 'song',
              id: String(args.song_id),
              name: String(args.song_id),
            },
            ...programsAffected(uniq(playing, queued, sequenced)),
          ],
          recoverable: true,
        }),
        onAir: (_args, { playing }) => playing.length > 0,
        run: (args) => {
          const { song_id: songId, ...fields } = args;
          return this.songs.update(
            songId,
            songInput(fields),
            this.pompeii.teamId,
          );
        },
      }),
      actionSpec({
        name: 'song_remove',
        title: 'Delete a song',
        description:
          "Deletes a song with its media asset, cover link, chart identity, intro assignment and embeddings. Refused with on_air while a program is playing it, has it queued, or lists it in its song sequence. Not recoverable. Stricter than the console, which deletes whatever is playing: it also refuses a song that is in any program's rotation.",
        permission: permissions.manage,
        tier: 'D',
        untrusted: SONG_UNTRUSTED,
        shape: { song_id: rowIdArg },
        load: (args) => this.songInUse(args.song_id),
        id: (args) => String(args.song_id),
        label: (_args, { song }) =>
          [song.artist, song.title].filter(Boolean).join(' - '),
        plan: (args, { playing, queued, sequenced }) => ({
          summary: `Deletes song ${args.song_id} with its media asset, cover link, chart identity, intro assignment and embeddings. The file in storage stays, but the song, its analysis and its embeddings cannot be recovered (a new song gets a new id and must be analysed and embedded again). The console deletes without looking at what is live; this capability refuses while a program is playing it (${playing.length}), has it queued (${queued.length}) or lists it in its song sequence (${sequenced.length}).`,
          affects: [
            {
              kind: 'song',
              id: String(args.song_id),
              name: String(args.song_id),
            },
            ...programsAffected(uniq(playing, queued, sequenced)),
          ],
          recoverable: false,
        }),
        refuse: (args, { playing, queued, sequenced }) =>
          whyNot([
            [
              playing.length > 0,
              `song ${args.song_id} is playing on ${playing.join(', ')}`,
            ],
            [
              queued.length > 0,
              `song ${args.song_id} is queued on ${queued.join(', ')}`,
            ],
            [
              sequenced.length > 0,
              `song ${args.song_id} is in the song sequence of ${sequenced.join(', ')}`,
            ],
          ]),
        run: (args) => this.songs.remove(args.song_id, this.pompeii.teamId),
      }),
    ];
  }
}
