import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { AsRunService } from '../../as-run/as-run.service';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { PompeiiService } from '../../auth/pompeii.service';
import { FlightService } from '../../program/flight.service';
import { ProgramService } from '../../program/program.service';
import { PalazzoRadioTelemetryService } from '../../radio/palazzo-telemetry.service';
import { RadioOutputConfidenceService } from '../../radio/radio-output-confidence.service';
import { RadioService } from '../../radio/radio.service';
import { SongExecutionEngine } from '../../radio/song-execution.engine';
import {
  findUniqueProgramSongLeafById,
  normalizeProgramSongSequence,
} from '../../radio/song-sequence.utils';
import { SongsService } from '../../songs/songs.service';
import {
  McpToolError,
  McpToolProvider,
  UNTRUSTED_NOTE,
  type McpContext,
  type McpOutcome,
  type McpToolProviderShape,
  type McpToolSpec,
} from '../contract';
import { MCP_READ_LIMITS, MCP_WAIT_MAX_SECONDS } from '../mcp.constants';
import { McpChangeFeed } from './mcp-change.feed';

const DAY_MS = 24 * 60 * 60 * 1000;

const programId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe(
    'The program. Optional only when exactly one radio program exists.',
  );

const timestamp = (what: string) =>
  z.string().min(1).max(40).describe(`${what}: an ISO 8601 timestamp.`);

/** What a service refused, as the closed refusal codes. */
async function guarded<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      (error instanceof Error && error.message === 'Program not found')
    )
      throw new McpToolError('not_found', 'Not found.');
    if (error instanceof BadRequestException)
      throw new McpToolError('invalid', 'The request was refused.');
    throw error;
  }
}

function parseWindow(
  from: string,
  to: string,
  maxDays: number,
): { from: Date; to: Date } {
  const start = new Date(Date.parse(from));
  const end = new Date(Date.parse(to));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    throw new McpToolError('invalid', 'from and to must be ISO 8601 times.');
  if (end.getTime() <= start.getTime())
    throw new McpToolError('invalid', 'to must be after from.');
  if (end.getTime() - start.getTime() > maxDays * DAY_MS)
    throw new McpToolError('invalid', `The window is at most ${maxDays} days.`);
  return { from: start, to: end };
}

/** Types a spec by its own shape, then widens it for the registry. */
function tool<Shape extends z.ZodRawShape>(
  spec: McpToolSpec<Shape>,
): McpToolSpec {
  return spec as unknown as McpToolSpec;
}

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * The radio read tools of gaulatti/alcantara#214 (tier R, no confirm and no
 * idempotency). Each calls the services the console's controllers call, in
 * process, with its own permission, and returns the same state. Text people
 * entered (titles, artists, names) sits under an `untrusted` key. No result
 * carries a playback token, an audio or cover URL, a Palazzo address, or a
 * ticket.
 */
@Injectable()
@McpToolProvider()
export class McpRadioReadTools implements McpToolProviderShape {
  /** wait_for_change calls held open, by caller. */
  private readonly waits = new Map<string, number>();

  constructor(
    private readonly programs: ProgramService,
    private readonly flight: FlightService,
    private readonly engine: SongExecutionEngine,
    private readonly telemetry: PalazzoRadioTelemetryService,
    private readonly confidence: RadioOutputConfidenceService,
    private readonly radio: RadioService,
    private readonly asRun: AsRunService,
    private readonly songs: SongsService,
    private readonly feed: McpChangeFeed,
    private readonly pompeii: PompeiiService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      this.getOnAir(),
      this.getQueue(),
      this.getRundown(),
      this.waitForChange(),
      this.getAsRun(),
      this.getRoyaltySummary(),
      this.searchSongs(),
      this.getSong(),
      this.getInstants(),
      this.getRadioHealth(),
    ];
  }

  /** The program asked for, or the only radio program there is. */
  private async resolveProgram(given: string | undefined): Promise<string> {
    if (given) return given;
    const all = (await this.programs.listPrograms()) as Array<{
      programId: string;
      type: string;
    }>;
    const radio = all.filter(
      (program) => program.type === 'radio' || program.type === 'both',
    );
    if (radio.length !== 1)
      throw new McpToolError(
        'invalid',
        radio.length === 0
          ? 'There is no radio program: pass program_id.'
          : 'There is more than one radio program: pass program_id.',
      );
    return radio[0].programId;
  }

  /** The same existence check the console's output-confidence route makes. */
  private async requireProgram(program: string): Promise<void> {
    await this.radio.getRadioSettings(program);
  }

  private confidenceOf(program: string) {
    const confidence = this.confidence.get(program);
    return {
      state: confidence.state,
      expected_audio: confidence.expectedAudio,
      output_rms: confidence.outputRms,
      last_sample_at: confidence.lastSampleAt,
      quiet_for_ms: confidence.quietForMs,
      // The dead-air watchdog's episode: the last step taken, whether it gave up, and what holds the next step.
      dead_air: confidence.deadAir
        ? {
            step: confidence.deadAir.step,
            gave_up: confidence.deadAir.gaveUp,
            held: confidence.deadAir.held,
            since: confidence.deadAir.since,
          }
        : null,
    };
  }

  private connectionOf(program: string) {
    const status = this.telemetry.getStatus(program);
    return status
      ? {
          connection: status.connection,
          degraded: status.degraded,
          last_event_at: status.lastEventAt,
          last_snapshot_at: status.lastSnapshotAt,
        }
      : null;
  }

  private getOnAir() {
    return tool({
      name: 'get_on_air',
      title: 'What is on air',
      description: `Reports what the radio is playing now: the song (playback request id, start time, seconds remaining), the song announced next, the rotation mode (manual, autoplay or shuffle), whether automation is frozen, the Palazzo connection and the output confidence. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: { program_id: programId },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          await this.requireProgram(program);
          const view = this.engine.getOnAirView(program);
          const playback = this.engine.getPlaybackState(program);
          const remaining =
            playback && playback.durationMs > 0
              ? Math.max(
                  0,
                  Math.round(
                    (playback.durationMs - playback.positionMs) / 1000,
                  ),
                )
              : null;
          const song =
            playback && view.playbackRequestId
              ? {
                  playback_request_id: view.playbackRequestId,
                  song_id: view.songId,
                  started_at: playback.startedAt,
                  remaining_seconds: remaining,
                  queue_entry_id: playback.queueEntryId,
                  intro_status: playback.introStatus,
                  telemetry_stale: playback.telemetryStale,
                  untrusted: { title: playback.title, artist: playback.artist },
                }
              : null;
          return {
            result: {
              program_id: program,
              song,
              ...(view.next
                ? {
                    next: {
                      playback_id: view.next.playbackId,
                      status: view.next.status,
                      untrusted: {
                        title: view.next.title,
                        artist: view.next.artist,
                      },
                    },
                  }
                : {}),
              mode: view.mode,
              frozen: view.frozen,
              palazzo: {
                connection:
                  this.telemetry.getStatus(program)?.connection ?? null,
              },
              output_confidence: this.confidenceOf(program),
            },
            audit: { target: program, count: song ? 1 : 0 },
          };
        }),
    });
  }

  private getQueue() {
    return tool({
      name: 'get_queue',
      title: 'Play Next queue',
      description: `Lists the Play Next queue in order, with each entry's id (entry_id), song id and whether it is the one playing, and the version of the rotation (sequence_version), which a save of the rotation must send. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: { program_id: programId },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          const bus = await this.programs.getProgramAudioBus(program);
          const sequence = normalizeProgramSongSequence(bus.songSequence);
          const entries = bus.songQueue.map((entry) => {
            const leaf = sequence
              ? findUniqueProgramSongLeafById(sequence, entry.itemId)
              : null;
            return {
              entry_id: entry.id,
              item_id: entry.itemId,
              song_id: leaf?.songId ?? null,
              playing: entry.active === true,
              enqueued_at: new Date(entry.enqueuedAt).toISOString(),
              untrusted: {
                title: leaf?.title ?? null,
                artist: leaf?.artist ?? null,
              },
            };
          });
          return {
            result: {
              program_id: program,
              sequence_version: bus.sequenceVersion,
              entries,
            },
            audit: { target: program, count: entries.length },
          };
        }),
    });
  }

  private getRundown() {
    return tool({
      name: 'get_rundown',
      title: 'Rundown',
      description: `Lists the program's rundown sequences (flight logs) with the active one and, for each clocked log that has not started, a preflight summary (ready, the number of issues, and the number of warnings that never block a start). Cue contents are not listed, only their count. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.flight.read,
      tier: 'R',
      firstClass: true,
      shape: { program_id: programId },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          const sequences = await this.flight.listFlightSequences(program);
          const active = await this.flight.getActiveFlightSequence(program);
          const preflighted = new Set(
            sequences
              .filter(
                (sequence) => sequence.scheduledAt && !sequence.lastStartedAt,
              )
              .slice(0, MCP_READ_LIMITS.rundownPreflightMax)
              .map((sequence) => sequence.id),
          );
          const listed: Array<Record<string, unknown>> = [];
          for (const sequence of sequences) {
            const preflight = preflighted.has(sequence.id)
              ? await this.flight.preflightFlightSequence(program, sequence.id)
              : null;
            listed.push({
              sequence_id: sequence.id,
              loop: sequence.loop,
              running: sequence.isRunning,
              active_item_id: sequence.activeItemId,
              item_count: sequence.items.length,
              scheduled_at: iso(sequence.scheduledAt),
              published_at: iso(sequence.publishedAt),
              last_started_at: iso(sequence.lastStartedAt),
              revision: sequence.revision,
              ...(preflight
                ? {
                    preflight: {
                      ready: preflight.ready,
                      issue_count: preflight.issues.length,
                      warning_count: preflight.warnings.length,
                    },
                  }
                : {}),
              untrusted: { name: sequence.name },
            });
          }
          return {
            result: {
              program_id: program,
              active_sequence_id: active?.activeSequenceId ?? null,
              sequences: listed,
            },
            audit: { target: program, count: listed.length },
          };
        }),
    });
  }

  private waitForChange() {
    return tool({
      name: 'wait_for_change',
      title: 'Wait for a change',
      description: `Holds the call open until the radio changes, for at most timeout_seconds (${MCP_WAIT_MAX_SECONDS} at most), and returns the first change or {timeout: true}. A change is a song confirmed on air or ended, the song going off air, the queue changing, a song Palazzo could not load, the Palazzo connection changing, or the rundown changing; playback progress is not a change. Each change has a sequence number, per program and counted from 1 since the backend started. Pass the last sequence you saw as since_sequence to get the next change without missing one (missed is true if older changes were dropped, reset is true if the backend restarted); leave it out to wait for a change after now. At most ${MCP_READ_LIMITS.concurrentWaitsPerIdentity} waits per caller at once. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: {
        program_id: programId,
        since_sequence: z.number().int().min(0).optional(),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MCP_WAIT_MAX_SECONDS)
          .optional(),
      },
      run: (args, ctx: McpContext) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          await this.requireProgram(program);
          const identity = ctx.principal.principalId ?? ctx.principal.subject;
          const held = this.waits.get(identity) ?? 0;
          if (held >= MCP_READ_LIMITS.concurrentWaitsPerIdentity)
            throw new McpToolError(
              'rate_limited',
              `At most ${MCP_READ_LIMITS.concurrentWaitsPerIdentity} waits may be open at once.`,
              MCP_WAIT_MAX_SECONDS,
            );
          this.waits.set(identity, held + 1);
          try {
            const answer = await this.feed.wait(
              program,
              args.since_sequence,
              (args.timeout_seconds ?? MCP_WAIT_MAX_SECONDS) * 1000,
            );
            if (answer.outcome === 'timeout')
              return {
                result: {
                  program_id: program,
                  timeout: true,
                  sequence: answer.sequence,
                },
                audit: { target: program, count: 0 },
              };
            if (answer.outcome === 'reset')
              return {
                result: {
                  program_id: program,
                  timeout: false,
                  reset: true,
                  sequence: answer.sequence,
                },
                audit: { target: program, count: 0 },
              };
            const change = answer.change;
            return {
              result: {
                program_id: program,
                timeout: false,
                sequence: change.sequence,
                missed: answer.missed,
                change: {
                  kind: change.kind,
                  at: change.at,
                  ...(change.playbackRequestId
                    ? { playback_request_id: change.playbackRequestId }
                    : {}),
                  ...(change.reason ? { reason: change.reason } : {}),
                  ...(change.untrusted ? { untrusted: change.untrusted } : {}),
                },
              },
              audit: { target: program, count: 1 },
            };
          } finally {
            const left = (this.waits.get(identity) as number) - 1;
            if (left > 0) this.waits.set(identity, left);
            else this.waits.delete(identity);
          }
        }),
    });
  }

  private getAsRun() {
    return tool({
      name: 'get_as_run',
      title: 'As-run log',
      description: `Lists as-run log rows between from and to (at most ${MCP_READ_LIMITS.asRunWindowDays} days apart), oldest first, at most limit rows (${MCP_READ_LIMITS.asRunLimitMax} at most). Each row is a song start or end with its time, whether the end was inferred, its review flag and the reason the engine itself ended the play (stopped, replaced, superseded, preempted, fixed_start, or playout_restart for a song cut when the playout engine restarted). truncated is true when the window holds more rows. Each row says who acted: actor_principal_id and actor_via (console or mcp), and the MCP client name as untrusted.actor_client; all are null for an automatic end. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: {
        program_id: programId,
        from: timestamp('Start of the window'),
        to: timestamp('End of the window'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP_READ_LIMITS.asRunLimitMax)
          .optional(),
      },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const window = parseWindow(
            args.from,
            args.to,
            MCP_READ_LIMITS.asRunWindowDays,
          );
          const program = await this.resolveProgram(args.program_id);
          await this.requireProgram(program);
          const listed = await this.asRun.listRecords(
            program,
            window.from,
            window.to,
            args.limit ?? MCP_READ_LIMITS.asRunLimitDefault,
          );
          return {
            result: {
              program_id: program,
              from: window.from.toISOString(),
              to: window.to.toISOString(),
              truncated: listed.truncated,
              records: listed.records.map((record) => ({
                record_id: record.id,
                state: record.state,
                at: record.at.toISOString(),
                playback_request_id: record.playbackRequestId,
                song_id: record.songId,
                asset_id: record.assetId,
                inferred: record.inferred,
                review_flag: record.reviewFlag,
                end_reason: record.endReason,
                actor_principal_id: record.actorPrincipalId,
                actor_via: record.actorVia,
                untrusted: {
                  title: record.title,
                  artist: record.artist,
                  actor_client: record.actorClient,
                },
              })),
            },
            audit: { target: program, count: listed.records.length },
          };
        }),
    });
  }

  private getRoyaltySummary() {
    return tool({
      name: 'get_royalty_summary',
      title: 'Royalty summary',
      description: `Counts the performances of each song between from and to (at most ${MCP_READ_LIMITS.royaltyWindowDays} days apart): the rows of the SoundExchange export, as data, most played first, at most ${MCP_READ_LIMITS.royaltySongsMax} songs (truncated says when there are more). Inferred ends count; a preempted song does not. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: {
        program_id: programId,
        from: timestamp('Start of the window'),
        to: timestamp('End of the window'),
      },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const window = parseWindow(
            args.from,
            args.to,
            MCP_READ_LIMITS.royaltyWindowDays,
          );
          const program = await this.resolveProgram(args.program_id);
          await this.requireProgram(program);
          const performances = await this.asRun.summarizePerformances(
            program,
            window.from,
            window.to,
          );
          performances.sort(
            (a, b) =>
              b.count - a.count ||
              a.artist.localeCompare(b.artist) ||
              a.title.localeCompare(b.title),
          );
          const listed = performances.slice(0, MCP_READ_LIMITS.royaltySongsMax);
          return {
            result: {
              program_id: program,
              from: window.from.toISOString(),
              to: window.to.toISOString(),
              total_performances: performances.reduce(
                (sum, item) => sum + item.count,
                0,
              ),
              total_songs: performances.length,
              truncated: performances.length > listed.length,
              songs: listed.map((item) => ({
                song_id: item.songId,
                asset_id: item.assetId,
                performances: item.count,
                untrusted: { title: item.title, artist: item.artist },
              })),
            },
            audit: { target: program, count: listed.length },
          };
        }),
    });
  }

  private searchSongs() {
    return tool({
      name: 'search_songs',
      title: 'Search songs',
      description: `Searches the song library by title, artist or chart id, at most limit songs (${MCP_READ_LIMITS.songSearchMax} at most), ordered by artist. Each song has its id, whether it is enabled, its duration and the status of its audio analysis (success, pending, failed, or none when it has no analysis). ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.song.read,
      tier: 'R',
      firstClass: true,
      shape: {
        query: z.string().trim().min(1).max(100),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP_READ_LIMITS.songSearchMax)
          .optional(),
      },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          // The station team's songs only (gaulatti/alcantara#122).
          const found = await this.songs.findAll(
            {
              search: args.query,
              sortBy: 'artist',
              sortOrder: 'asc',
              page: 1,
              limit: args.limit ?? MCP_READ_LIMITS.songSearchDefault,
            },
            this.pompeii.teamId,
          );
          const analyses = await this.songs.findAnalyses(
            found.data
              .map((song) => song.assetId)
              .filter((id): id is string => typeof id === 'string'),
          );
          return {
            result: {
              total: found.meta.total,
              songs: found.data.map((song) => ({
                song_id: song.id,
                enabled: song.enabled,
                duration_ms: song.durationMs,
                analysis_status:
                  (song.assetId && analyses.get(song.assetId)?.status) ||
                  'none',
                untrusted: { title: song.title, artist: song.artist },
              })),
            },
            audit: { count: found.data.length },
          };
        }),
    });
  }

  private getSong() {
    return tool({
      name: 'get_song',
      title: 'Song details',
      description: `Reads one song: its metadata and the stored audio analysis (status, cue in and out, fades, overlap, integrated loudness and true peak). A manual cue or loudness override is not listed: none is stored today. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.song.read,
      tier: 'R',
      firstClass: true,
      shape: { song_id: z.number().int().min(1) },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          // Another team's song is not found, as in the search above (#122).
          const song = await this.songs.findOne(
            args.song_id,
            undefined,
            this.pompeii.teamId,
          );
          const analysis = song.assetId
            ? ((await this.songs.findAnalyses([song.assetId])).get(
                song.assetId,
              ) ?? null)
            : null;
          return {
            result: {
              song_id: song.id,
              enabled: song.enabled,
              duration_ms: song.durationMs,
              asset_id: song.assetId,
              intro_instant_id: song.intro?.instantId ?? null,
              created_at: song.createdAt.toISOString(),
              updated_at: song.updatedAt.toISOString(),
              analysis: analysis
                ? {
                    status: analysis.status,
                    cue_in_seconds: analysis.cueInSeconds,
                    cue_out_seconds: analysis.cueOutSeconds,
                    fade_in_seconds: analysis.fadeInSeconds,
                    fade_out_seconds: analysis.fadeOutSeconds,
                    overlap_seconds: analysis.overlapSeconds,
                    integrated_lufs: analysis.integratedLufs,
                    true_peak_dbtp: analysis.truePeakDbtp,
                    analyzed_at: analysis.updatedAt.toISOString(),
                  }
                : null,
              untrusted: { title: song.title, artist: song.artist },
            },
            audit: { target: String(song.id) },
          };
        }),
    });
  }

  private getInstants() {
    return tool({
      name: 'get_instants',
      title: 'Instants',
      description: `Lists the instants (short clips): id, name, volume, whether enabled and whether one is free to be a song intro, with the song it introduces in this program. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.instant.read,
      tier: 'R',
      firstClass: true,
      shape: { program_id: programId },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          const instants = await this.programs.listInstants(program);
          return {
            result: {
              program_id: program,
              instants: instants.map((instant) => ({
                instant_id: instant.id,
                enabled: instant.enabled,
                volume: instant.volume,
                available_for_song_intro: instant.availableForSongIntro,
                assigned_song_id: instant.assignedSongId,
                untrusted: { name: instant.name },
              })),
            },
            audit: { target: program, count: instants.length },
          };
        }),
    });
  }

  private getRadioHealth() {
    return tool({
      name: 'get_radio_health',
      title: 'Radio health',
      description: `Summarizes the radio's health: the Palazzo connection (connected, degraded, last event), the output confidence (audible, silent, idle, unknown) and the recovery state (the filler prepared, the automation Palazzo reports and whether it answered). The recovery state asks Palazzo, as the console does. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: true,
      shape: { program_id: programId },
      run: (args) =>
        guarded(async (): Promise<McpOutcome> => {
          const program = await this.resolveProgram(args.program_id);
          await this.requireProgram(program);
          const recovery = await this.radio.getRecoveryStatus(program);
          return {
            result: {
              program_id: program,
              palazzo: this.connectionOf(program),
              output_confidence: this.confidenceOf(program),
              recovery: {
                connection: recovery.connection,
                selected_song_ids: recovery.selectedSongIds,
                prepared_version: recovery.preparedVersion,
                automation: recovery.automation
                  ? {
                      last_sequence: recovery.automation.lastSequence,
                      requested_state: recovery.automation.requestedState,
                      actual_state: recovery.automation.actualState,
                      filler: {
                        active_version:
                          recovery.automation.filler.activeVersion,
                        ready: recovery.automation.filler.ready,
                      },
                    }
                  : null,
              },
            },
            audit: { target: program },
          };
        }),
    });
  }
}
