import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { NowPlayingPublisherService } from '../../radio/now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from '../../radio/palazzo-telemetry.service';
import { RadioOutputConfidenceService } from '../../radio/radio-output-confidence.service';
import { RadioService } from '../../radio/radio.service';
import { SongExecutionEngine } from '../../radio/song-execution.engine';
import { SongSimilarityService } from '../../radio/song-similarity.service';
import { ProgramService } from '../../program/program.service';
import { z } from 'zod';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { loadProgramLive, type ProgramLive } from './on-air';
import {
  actionSpec,
  present,
  programIdArg,
  readSpec,
  type Args,
} from './support';

const permissions = ALCANTARA_PERMISSIONS.radio;

const urlArg = z.string().trim().min(1).max(2048);
const songIdsArg = z.array(z.number().int().positive()).min(1).max(100);
/** The fields of the radio settings; every one is optional, as in the console. */
const settingsShape = {
  palazzo_url: urlArg.optional(),
  listener_url: z.string().trim().max(2048).nullable().optional(),
  bumper_enabled: z.boolean().optional(),
  bumper_interval: z.number().int().min(0).nullable().optional(),
  bumper_instant_ids: z.array(z.number().int().positive()).max(100).optional(),
  bumper_mode: z.enum(['sequential', 'random']).optional(),
  enabled: z.boolean().optional(),
  segue_mode: z.enum(['off', 'on']).optional(),
  similarity_mode: z.enum(['off', 'shadow', 'on']).optional(),
  similarity_threshold: z.number().min(-1).max(1).optional(),
  similarity_window_seconds: z.number().int().min(1).max(86_400).optional(),
  similarity_pool: z.enum(['sequence', 'catalog']).optional(),
};
/** The fields that change what the radio plays or where it plays from. */
const LIVE_SETTINGS = [
  'palazzo_url',
  'bumper_enabled',
  'bumper_interval',
  'bumper_instant_ids',
  'bumper_mode',
  'enabled',
  'segue_mode',
  'similarity_mode',
  'similarity_threshold',
  'similarity_window_seconds',
  'similarity_pool',
] as const;

const consumerArg = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  url: urlArg,
  method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  headers: z.record(z.string().max(200), z.string().max(2000)).optional(),
  keep_stored_headers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

interface StoredConsumer {
  name: string;
  url: string;
  headers: unknown;
}

interface Recovery {
  connection: 'connected' | 'unavailable';
  preparedVersion: string | null;
  automation: {
    lastSequence: number;
    requestedState: string;
    actualState: string;
    filler: { activeVersion: string | null; ready: boolean };
  } | null;
}

/** Where the recovery session is, in words; it changes when it starts or stops. */
const recoveryStamp = (recovery: Recovery): string =>
  recovery.automation
    ? `recovery=${recovery.automation.requestedState}/${recovery.automation.actualState} seq=${recovery.automation.lastSequence}`
    : 'recovery=palazzo-unavailable';

/**
 * gaulatti/alcantara#219: the radio capabilities that are not songs or
 * similarity (#218): settings, the Palazzo and output confidence reads, the
 * recovery (filler) session, the now-playing consumers and the manual song and
 * instant routes. The monitor ticket route is not a capability (appendix A: it
 * returns a credential).
 *
 * A now-playing consumer's request headers can carry an API key. They are
 * never returned: an answer lists each consumer's `headerNames` (under
 * `untrusted`) and nothing of the values.
 */
@Injectable()
@McpToolProvider()
export class RadioMcpTools {
  constructor(
    private readonly radio: RadioService,
    private readonly consumers: NowPlayingPublisherService,
    private readonly telemetry: PalazzoRadioTelemetryService,
    private readonly confidence: RadioOutputConfidenceService,
    private readonly similarity: SongSimilarityService,
    private readonly engine: SongExecutionEngine,
    private readonly programs: ProgramService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      ...this.reads(),
      ...this.writes(),
      ...this.recoveryActions(),
      ...this.playbackActions(),
    ];
  }

  private reads(): McpToolSpec[] {
    const programArg = { program_id: programIdArg };
    return [
      readSpec({
        name: 'radio_get_settings',
        title: 'Read the radio settings of a program',
        description:
          'Reads the radio settings of a program (Palazzo address, listener address, bumpers, recovery playlist, segue and similarity settings); null when the program has none yet.',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getRadioSettings(args.program_id),
      }),
      readSpec({
        name: 'radio_get_palazzo_status',
        title: 'Read the Palazzo link of a program',
        description:
          'Reads the live link to the Palazzo audio engine of a program (connection, last event and snapshot times, degraded flag); null when the program has no link.',
        permission: permissions.read,
        shape: programArg,
        run: (args) =>
          Promise.resolve(this.telemetry.getStatus(args.program_id)),
      }),
      readSpec({
        name: 'radio_get_output_confidence',
        title: 'Read the output confidence of a program',
        description:
          'Reads whether audio is actually leaving the radio output of a program (state, expected audio, level and silence).',
        permission: permissions.read,
        shape: programArg,
        run: async (args) => {
          await this.radio.getRadioSettings(args.program_id);
          return this.confidence.get(args.program_id);
        },
      }),
      readSpec({
        name: 'radio_get_recovery',
        title: 'Read the recovery session of a program',
        description:
          'Reads the recovery (filler) session of a radio program: the selected songs, the prepared version and Palazzo\'s automation state; `connection` is "unavailable" when Palazzo cannot be reached.',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getRecoveryStatus(args.program_id),
      }),
      readSpec({
        name: 'radio_list_now_playing_consumers',
        title: 'List the now-playing consumers of a program',
        description:
          'Lists the endpoints that are told what is playing: name, address, method, enabled and position. Header values are never returned; `headerNames` lists the names of the headers a consumer sends.',
        permission: permissions.read,
        shape: programArg,
        untrusted: ['url'],
        run: async (args) =>
          withoutHeaderValues(
            await this.consumers.listConsumers(args.program_id),
          ),
      }),
      readSpec({
        name: 'radio_now_playing_publishing',
        title: 'Read whether now-playing updates leave the machine',
        description:
          'Says whether now-playing updates are published ("enabled") or held back on a local stack ("blocked-local").',
        permission: permissions.read,
        shape: programArg,
        run: () =>
          Promise.resolve({
            publishing: this.consumers.outboundPublishing(),
          }),
      }),
      readSpec({
        name: 'radio_get_status',
        title: 'Read whether the radio output is running',
        description:
          'Reads whether the radio engine of a program is running (liquidsoap and icecast connected).',
        permission: permissions.read,
        shape: programArg,
        run: (args) => this.radio.getPalazzoStatus(args.program_id),
      }),
    ];
  }

  /** The settings, the recovery playlist and the now-playing consumers. */
  private writes(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'radio_update_settings',
        title: 'Change the radio settings of a program',
        description:
          'Changes the radio settings of a program (Palazzo address, listener address, bumpers, segue, similarity, enabled). Only the fields given change. A change to the Palazzo address or to enabled makes the telemetry link reconnect; similarity fields reload the similarity settings.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, ...settingsShape },
        load: (args) => this.radio.getRadioSettings(args.program_id),
        id: (args) => args.program_id,
        plan: (args) => {
          const fields = Object.keys(settingsShape).filter(
            (key) => (args as Record<string, unknown>)[key] !== undefined,
          );
          return {
            summary: `Changes ${fields.length} radio setting(s) of program ${args.program_id}: ${fields.join(', ') || 'none'}. The previous values are not kept: read the settings first to restore them.`,
            affects: [
              { kind: 'program', id: args.program_id, name: args.program_id },
            ],
            recoverable: true,
          };
        },
        onAir: (args) =>
          LIVE_SETTINGS.some(
            (key) => (args as Record<string, unknown>)[key] !== undefined,
          ),
        run: async (args, previous) => {
          const data = present({
            palazzoUrl: args.palazzo_url,
            listenerUrl: args.listener_url,
            bumperEnabled: args.bumper_enabled,
            bumperInterval: args.bumper_interval,
            bumperInstantIds: args.bumper_instant_ids,
            bumperMode: args.bumper_mode,
            enabled: args.enabled,
            segueMode: args.segue_mode,
            similarityMode: args.similarity_mode,
            similarityThreshold: args.similarity_threshold,
            similarityWindowSeconds: args.similarity_window_seconds,
            similarityPool: args.similarity_pool,
          });
          // The same three steps as the console's controller; the settings
          // read first are the ones it loaded for the plan.
          const result = await this.radio.updateRadioSettings(
            args.program_id,
            data,
          );
          if (
            data.similarityMode !== undefined ||
            data.similarityThreshold !== undefined ||
            data.similarityWindowSeconds !== undefined ||
            data.similarityPool !== undefined
          )
            await this.similarity.onSettingsChanged();
          if (
            previous?.palazzoUrl !== result.palazzoUrl ||
            previous?.enabled !== result.enabled
          )
            await this.telemetry.handleRadioSettingsChanged(args.program_id);
          return result;
        },
      }),
      actionSpec({
        name: 'radio_prepare_recovery',
        title: 'Prepare the recovery playlist of a program',
        description:
          'Prepares one to 100 distinct catalog songs as the recovery (fallback) playlist: Palazzo downloads and verifies them, and the version is saved only after it reports ready. Refused with conflict once a program radio filler is configured. It does not start a session.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, song_ids: songIdsArg },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Prepares ${args.song_ids.length} song(s) as the recovery playlist of program ${args.program_id}: each is read to take its SHA-256 and Palazzo downloads them. The new version replaces the prepared one only when Palazzo reports ready; a session already running keeps its version.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
            ...args.song_ids.map((id) => ({
              kind: 'song',
              id: String(id),
              name: String(id),
            })),
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.radio.prepareRecoveryPlaylist(args.program_id, args.song_ids),
      }),
      actionSpec({
        name: 'radio_replace_now_playing_consumers',
        title: 'Replace the now-playing consumers of a program',
        description:
          "Replaces the whole list of endpoints that are told what is playing: any consumer not in the list is deleted. A consumer's header values are never returned; set keep_stored_headers to keep the headers stored for the consumer of the same name (headers given beside it win).",
        permission: permissions.manage,
        tier: 'W',
        untrusted: ['url'],
        shape: {
          program_id: programIdArg,
          consumers: z.array(consumerArg).max(50),
        },
        load: async (args) =>
          (await this.consumers.listConsumers(
            args.program_id,
          )) as StoredConsumer[],
        id: (args) => args.program_id,
        plan: (args, stored) => {
          const kept = new Set(args.consumers.map((consumer) => consumer.name));
          const dropped = stored.filter((consumer) => !kept.has(consumer.name));
          // A bad keep_stored_headers is reported by the dry run, not at run time.
          this.payloads(args.consumers, stored);
          return {
            summary: `Replaces the ${stored.length} stored now-playing consumer(s) of program ${args.program_id} with ${args.consumers.length}. ${dropped.length} stored consumer(s) not in the list are deleted with their headers, which cannot be recovered. Now-playing updates go to the new list from the next song change.`,
            affects: [
              { kind: 'program', id: args.program_id, name: args.program_id },
              ...dropped.map((consumer) => ({
                kind: 'now_playing_consumer',
                id: consumer.name,
                name: consumer.name,
              })),
            ],
            recoverable: false,
          };
        },
        run: async (args, stored) => {
          try {
            return withoutHeaderValues(
              await this.consumers.replaceConsumers(
                args.program_id,
                this.payloads(args.consumers, stored),
              ),
            );
          } catch (error) {
            // The console reports every refusal of this route as a 400.
            if (error instanceof McpToolError) throw error;
            throw new McpToolError(
              'invalid',
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      }),
    ];
  }

  /** The consumers as the service takes them, stored headers kept where asked. */
  private payloads(
    consumers: Array<z.infer<typeof consumerArg>>,
    stored: StoredConsumer[],
  ) {
    return consumers.map((consumer, index) => {
      let headers: Record<string, string> | undefined = consumer.headers;
      if (consumer.keep_stored_headers) {
        const previous = stored.find((row) => row.name === consumer.name);
        if (!consumer.name || !previous)
          throw new McpToolError(
            'invalid',
            `Consumer ${index + 1}: keep_stored_headers needs the name of a stored consumer.`,
          );
        headers = {
          ...(previous.headers as Record<string, string> | null),
          ...consumer.headers,
        };
      }
      return present({
        name: consumer.name,
        url: consumer.url,
        method: consumer.method,
        headers,
        enabled: consumer.enabled,
      }) as { url: string };
    });
  }

  private recoveryActions(): McpToolSpec[] {
    return (['start', 'stop'] as const).map((action) =>
      actionSpec<{ program_id: typeof programIdArg }, Recovery>({
        name: `radio_${action}_recovery`,
        title: `${action === 'start' ? 'Start' : 'Stop'} the recovery session`,
        description:
          action === 'start'
            ? 'Starts the recovery (fallback) session of a radio program, bound to the program radio filler version (or, without one, the prepared recovery playlist): when the live song queue runs dry, Palazzo plays the local playlist. Needs a prepared playlist.'
            : 'Stops the recovery session of a radio program: the program audio is cleared and the binding to the playlist is dropped. Needs Palazzo to answer.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        load: (args) =>
          this.radio.getRecoveryStatus(args.program_id) as Promise<Recovery>,
        id: (args) => args.program_id,
        label: (_args, recovery) => recoveryStamp(recovery),
        plan: (args, recovery) => ({
          summary:
            action === 'start'
              ? `Starts the recovery session of program ${args.program_id} (now ${recoveryStamp(recovery)}, prepared version ${recovery.preparedVersion ?? 'none'}). When the song queue runs dry the prepared playlist plays on air. Recoverable with radio_stop_recovery.`
              : `Stops the recovery session of program ${args.program_id} (now ${recoveryStamp(recovery)}): the program audio is cleared and the playlist binding is dropped. Recoverable with radio_start_recovery.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.radio.setRecoveryAutomation(args.program_id, action),
      }),
    );
  }

  /** The manual song and instant routes: each confirms against the live stamp. */
  private playbackActions(): McpToolSpec[] {
    type OnProgram<S extends z.ZodRawShape> = S & {
      program_id: typeof programIdArg;
    };
    const programOf = (args: object) =>
      (args as { program_id: string }).program_id;
    const onProgram = <S extends z.ZodRawShape>(def: {
      name: string;
      title: string;
      description: string;
      shape: S;
      summary: (live: ProgramLive, programId: string) => string;
      recoverable: boolean;
      run: (args: Args<OnProgram<S>>) => Promise<unknown>;
    }) =>
      actionSpec<OnProgram<S>, ProgramLive>({
        name: def.name,
        title: def.title,
        description: def.description,
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg, ...def.shape } as OnProgram<S>,
        load: (args) => loadProgramLive(this.programs, programOf(args)),
        id: (args) => programOf(args),
        label: (_args, live) => live.stamp,
        plan: (args, live) => ({
          summary: def.summary(live, programOf(args)),
          affects: [
            { kind: 'program', id: programOf(args), name: programOf(args) },
          ],
          recoverable: def.recoverable,
        }),
        run: (args) => def.run(args),
      });
    return [
      onProgram({
        name: 'radio_play_song',
        title: 'Play a song now',
        description:
          "Plays the song at an audio address now on a radio program, as the console's manual play does. This is the raw route: it checks nothing about what is playing.",
        shape: {
          audio_url: urlArg,
          title: z.string().max(500).optional(),
          artist: z.string().max(500).optional(),
          cover_url: z.string().max(2048).optional(),
          duration_ms: z.number().int().min(0).optional(),
          song_id: z.number().int().positive().optional(),
        },
        summary: (live, programId) =>
          `Plays the given song now on program ${programId}, on air at once (${live.liveText}). Whatever plays now is replaced; the queue stays.`,
        recoverable: false,
        run: (args) => {
          this.engine.handleManualSong(
            args.program_id,
            args.audio_url,
            args.title,
            args.artist,
            args.duration_ms,
            args.cover_url,
            args.song_id,
          );
          return Promise.resolve({ ok: true });
        },
      }),
      onProgram({
        name: 'radio_stop_song',
        title: 'Stop the song that is playing',
        description:
          'Stops the song that is playing on a radio program and tells the engine to stop. The radio will be silent and the filler covers until someone resumes the rotation; automatic rotation turns manual.',
        shape: {},
        summary: (live, programId) =>
          `Stops the song playing on program ${programId} (${live.liveText}). The radio will be silent and the filler covers until someone resumes the rotation; automatic rotation turns manual.`,
        recoverable: true,
        run: async (args) => {
          await this.radio.stopSong(args.program_id);
          this.engine.handleStopSong(args.program_id);
          return { ok: true };
        },
      }),
      onProgram({
        name: 'radio_play_instant',
        title: 'Play an instant now',
        description:
          'Plays an instant (a short sound) at an audio address over a radio program, at an optional volume from 0 to 1. instant_id is accepted as the console sends it; the route does not use it.',
        shape: {
          audio_url: urlArg,
          instant_id: z.number().int().positive().optional(),
          volume: z.number().min(0).max(1).optional(),
        },
        summary: (live, programId) =>
          `Plays the instant over program ${programId} now, on air at once (${live.liveText}). It cannot be recalled; radio_stop_all_instants cuts it.`,
        recoverable: false,
        run: async (args) => {
          await this.radio.playInstant(
            args.program_id,
            args.audio_url,
            args.volume,
          );
          return { ok: true };
        },
      }),
      onProgram({
        name: 'radio_stop_all_instants',
        title: 'Stop every playing instant',
        description: 'Cuts every instant playing over a radio program.',
        shape: {},
        summary: (live, programId) =>
          `Cuts every instant playing over program ${programId} (${live.liveText}). Recoverable: an instant can be played again.`,
        recoverable: true,
        run: async (args) => {
          await this.radio.stopAllInstants(args.program_id);
          return { ok: true };
        },
      }),
    ];
  }
}

interface ConsumerRow {
  headers: unknown;
  [key: string]: unknown;
}

/** A consumer as stored, with the names of its headers instead of their values. */
export function withoutHeaderValues(rows: unknown): unknown[] {
  return (rows as ConsumerRow[]).map(({ headers, ...rest }) => ({
    ...rest,
    headerNames:
      headers && typeof headers === 'object' && !Array.isArray(headers)
        ? Object.keys(headers)
        : [],
  }));
}
