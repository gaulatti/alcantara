import { Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import { ProgramService } from '../../program/program.service';
import { RadioService } from '../../radio/radio.service';
import { SongExecutionEngine } from '../../radio/song-execution.engine';
import {
  normalizeProgramSongSequence,
  programSongPlayOrder,
  shuffleProgramSongOrder,
  type ProgramSongSequence,
} from '../../radio/song-sequence.utils';
import { SongsService } from '../../songs/songs.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { loadProgramLive, type ProgramLive } from './on-air';
import { actionSpec, programIdArg, readSpec } from './support';

const itemIdArg = z.string().trim().min(1).max(200);
const positionArg = z.number().int().min(1).max(5000);

/** The rotation as stored, to change and save back, and as the engine reads it. */
interface Loaded {
  live: ProgramLive;
  stored: Record<string, unknown> & { items: Array<Record<string, unknown>> };
  sequence: ProgramSongSequence;
  version: string;
  playing: boolean;
}

/**
 * gaulatti/alcantara#788: the radio desk's rotation actions, one tool each. Every write is the console's own save with
 * the rotation version it was made from, so a rotation that changed in between is refused, never overwritten.
 */
@Injectable()
@McpToolProvider()
export class RotationMcpTools {
  constructor(
    private readonly programs: ProgramService,
    private readonly radio: RadioService,
    private readonly engine: SongExecutionEngine,
    private readonly songs: SongsService,
    private readonly pompeii: PompeiiService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'radio_get_rotation',
        title: 'Read the rotation of a program',
        description:
          'The continuous rotation as the radio desk shows it: mode (manual, autoplay, shuffle), loop, the cursor item, when a rotation that does not loop ended, each song with its item_id in the operator’s row order, and play_order (the order that plays, which differs in shuffle).',
        permission: ALCANTARA_PERMISSIONS.radio.read,
        shape: { program_id: programIdArg },
        untrusted: ['title', 'artist'],
        run: async (args) => {
          const { sequence, version, playing } = await this.load(
            args.program_id,
          );
          return {
            program_id: args.program_id,
            mode: sequence.mode,
            loop: sequence.loop,
            playing,
            cursor_item_id: sequence.activeItemId,
            ended_at: sequence.endedAt
              ? new Date(sequence.endedAt).toISOString()
              : null,
            sequence_version: version,
            items: sequence.items.map((item) =>
              item.kind === 'preset'
                ? {
                    item_id: item.id,
                    song_id: item.songId ?? null,
                    high_rotation: item.highRotation === true,
                    title: item.title,
                    artist: item.artist,
                  }
                : { item_id: item.id, block: true },
            ),
            play_order: programSongPlayOrder(sequence).map((item) => item.id),
          };
        },
      }),
      actionSpec({
        name: 'radio_set_rotation_mode',
        title: 'Set Manual, Autoplay, Shuffle or Loop',
        description:
          'The desk’s playout mode buttons. mode manual, autoplay or shuffle; loop true or false. Shuffle makes a new play order (the current song first) and leaves the rows alone; calling it again reshuffles. Autoplay or shuffle with nothing on air starts the rotation at once.',
        permission: ALCANTARA_PERMISSIONS.program.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          mode: z.enum(['manual', 'autoplay', 'shuffle']).optional(),
          loop: z.boolean().optional(),
        },
        load: (args) => this.load(args.program_id),
        id: (args) => args.program_id,
        label: (_args, loaded) => loaded.live.stamp,
        plan: (args, { live, sequence, playing }) => ({
          summary: `Sets the rotation of program ${args.program_id} to ${[args.mode && `mode ${args.mode}`, args.loop !== undefined && `loop ${args.loop ? 'on' : 'off'}`].filter(Boolean).join(' and ') || 'nothing new'} (now ${sequence.mode}, loop ${sequence.loop ? 'on' : 'off'}).${args.mode && args.mode !== 'manual' && !playing ? ' Nothing is on air, so the rotation starts now.' : ''} Live now: ${live.liveText}.`,
          affects: this.affects(args.program_id),
          recoverable: true,
        }),
        refuse: (args, { sequence }) =>
          args.mode === undefined && args.loop === undefined
            ? 'Give mode, loop or both. Nothing was changed.'
            : args.mode === 'shuffle' && sequence.items.length < 2
              ? 'Shuffle needs at least two songs. Nothing was changed.'
              : null,
        run: (args, loaded) =>
          this.save(args.program_id, loaded, this.withMode(args, loaded)),
      }),
      actionSpec({
        name: 'radio_take_rotation_song',
        title: 'Take a rotation song on air',
        description:
          'The desk’s Take on a rotation row: puts that song on air now and moves the rotation’s cursor to it. item_id from radio_get_rotation. Refused while the engine is off or playout is down.',
        permission: ALCANTARA_PERMISSIONS.program.operate,
        tier: 'A',
        shape: { program_id: programIdArg, item_id: itemIdArg },
        load: (args) => this.load(args.program_id),
        id: (args) => args.program_id,
        label: (_args, loaded) => loaded.live.stamp,
        plan: (args, loaded) => ({
          summary: `Takes ${this.nameOf(loaded, args.item_id)} on air on program ${args.program_id} now, replacing whatever plays. Live now: ${loaded.live.liveText}.`,
          affects: this.affects(args.program_id),
          recoverable: false,
        }),
        refuse: (args, loaded) => {
          const item = loaded.sequence.items.find(
            (candidate) => candidate.id === args.item_id,
          );
          return item?.kind === 'preset' && item.audioUrl
            ? null
            : 'No rotation song with audio has that item_id. Nothing was taken.';
        },
        run: async (args, loaded) => {
          await this.radio.refuseStartWhileEngineUnavailable(args.program_id);
          const item = loaded.sequence.items.find(
            (candidate) => candidate.id === args.item_id,
          )!;
          await this.save(args.program_id, loaded, {
            ...loaded.stored,
            activeItemId: args.item_id,
            startedAt: Date.now(),
          });
          // As the console: saving an idle automatic rotation is itself the start; otherwise the song is taken.
          if (
            item.kind === 'preset' &&
            (loaded.playing || loaded.sequence.mode === 'manual')
          )
            this.engine.handleManualSong(
              args.program_id,
              item.audioUrl!,
              item.title,
              item.artist,
              item.durationMs,
              item.coverUrl,
              item.songId,
            );
          return { ok: true };
        },
      }),
      actionSpec({
        name: 'radio_move_rotation_song',
        title: 'Move a song in the rotation',
        description:
          'The desk’s Move up, Move down and drag: puts a rotation row at a position (1 is first). In shuffle the play order does not change; the rows are what Manual and Autoplay play.',
        permission: ALCANTARA_PERMISSIONS.program.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          item_id: itemIdArg,
          position: positionArg,
        },
        load: (args) => this.load(args.program_id),
        id: (args) => args.program_id,
        label: (_args, loaded) => loaded.live.stamp,
        plan: (args, loaded) => ({
          summary: `Moves ${this.nameOf(loaded, args.item_id)} to row ${Math.min(args.position, loaded.stored.items.length)} of ${loaded.stored.items.length} on program ${args.program_id}. Live now: ${loaded.live.liveText}.`,
          affects: this.affects(args.program_id),
          recoverable: true,
        }),
        refuse: (args, loaded) =>
          loaded.stored.items.some((item) => item.id === args.item_id)
            ? null
            : 'No rotation row has that item_id. Nothing was moved.',
        run: (args, loaded) => {
          const items = loaded.stored.items.filter(
            (item) => item.id !== args.item_id,
          );
          items.splice(
            args.position - 1,
            0,
            loaded.stored.items.find((item) => item.id === args.item_id)!,
          );
          return this.save(args.program_id, loaded, {
            ...loaded.stored,
            items,
          });
        },
      }),
      actionSpec({
        name: 'radio_add_rotation_song',
        title: 'Add a library song to the rotation',
        description:
          'The desk’s Add fillers, and how a removal is undone: adds a library song at a position (1 is first; at the end when not given). A song already in the rotation is refused.',
        permission: ALCANTARA_PERMISSIONS.program.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          song_id: z.number().int().positive(),
          position: positionArg.optional(),
        },
        load: async (args) => ({
          ...(await this.load(args.program_id)),
          // The station team's songs only, as the library reads (gaulatti/alcantara#122).
          song: await this.songs.findOne(
            args.song_id,
            undefined,
            this.pompeii.teamId,
          ),
        }),
        id: (args) => args.program_id,
        label: (_args, loaded) => loaded.live.stamp,
        plan: (args, loaded) => ({
          summary: `Adds song ${args.song_id} to the rotation of program ${args.program_id} at ${args.position ? `row ${args.position}` : 'the end'}. Live now: ${loaded.live.liveText}.`,
          affects: this.affects(args.program_id),
          recoverable: true,
        }),
        refuse: (_args, { song }) =>
          song.enabled && song.audioUrl?.trim()
            ? null
            : 'The song is disabled or has no audio. Nothing was added.',
        run: (args, loaded) => {
          const { song } = loaded;
          const items = [...loaded.stored.items];
          items.splice(args.position ? args.position - 1 : items.length, 0, {
            id: `song_${randomUUID()}`,
            kind: 'preset',
            songId: song.id,
            title: song.title,
            artist: song.artist,
            coverUrl: song.coverUrl ?? '',
            audioUrl: song.audioUrl,
            ...(song.durationMs ? { durationMs: song.durationMs } : {}),
            highRotation: false,
          });
          return this.save(args.program_id, loaded, {
            ...loaded.stored,
            items,
          });
        },
      }),
    ];
  }

  private async load(programId: string): Promise<Loaded> {
    const [live, bus] = await Promise.all([
      loadProgramLive(this.programs, programId),
      this.programs.getProgramAudioBus(programId),
    ]);
    const sequence = normalizeProgramSongSequence(bus.songSequence);
    if (!sequence)
      throw new McpToolError('not_found', 'This program has no rotation.');
    // A stored rotation the normalizer accepts can lack `items` (it reads none as []): the row tools read the stored
    // rows, so give them the same empty list rather than a TypeError the client sees as an internal error.
    const raw = bus.songSequence as unknown as Record<string, unknown>;
    const stored = {
      ...raw,
      items: Array.isArray(raw.items) ? raw.items : [],
    } as Loaded['stored'];
    return {
      live,
      stored,
      sequence,
      version: bus.sequenceVersion,
      playing: Boolean(this.engine.getPlaybackState(programId)?.isPlaying),
    };
  }

  /** What the playout mode buttons save (frontend PlayoutMode). */
  private withMode(
    args: { mode?: 'manual' | 'autoplay' | 'shuffle'; loop?: boolean },
    { stored, sequence, playing }: Loaded,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = {
      ...stored,
      ...(args.loop === undefined ? {} : { loop: args.loop }),
    };
    if (!args.mode) return next;
    next.mode = args.mode;
    // A start ends an ended rotation's state.
    if (args.mode !== 'manual') delete next.endedAt;
    if (args.mode === 'shuffle') {
      const order = shuffleProgramSongOrder(sequence, (limit) =>
        randomInt(limit),
      );
      next.shuffleOrder = order;
      next.activeItemId = sequence.activeItemId ?? order[0];
      if (!playing) next.startedAt = Date.now();
      return next;
    }
    next.activeItemId =
      sequence.activeItemId ??
      (args.mode === 'autoplay' ? (sequence.items[0]?.id ?? null) : null);
    next.startedAt = Date.now();
    return next;
  }

  private async save(
    programId: string,
    { version }: Loaded,
    songSequence: Record<string, unknown>,
  ) {
    const data = { songSequence };
    // The console's refusal of a start while the engine is off (gaulatti/alcantara#609).
    await this.programs.refuseOperatorStartWhileEngineUnavailable(
      data,
      programId,
    );
    const saved = await this.programs.updateProgramAudioBus(
      { ...data, sequenceVersion: version } as { songSequence: unknown },
      programId,
      'mcp',
    );
    return { ok: true, sequence_version: saved.sequenceVersion };
  }

  private nameOf({ sequence }: Loaded, itemId: string): string {
    const item = sequence.items.find((candidate) => candidate.id === itemId);
    return item?.kind === 'preset'
      ? `rotation song ${itemId}`
      : `rotation row ${itemId}`;
  }

  private affects(programId: string) {
    return [{ kind: 'program', id: programId, name: programId }];
  }
}
