import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  RadioMetricsService,
  type AnalysisDropResult,
  type CueGroupShape,
} from './radio-metrics.service';
import { PrismaService } from '../prisma.service';
import { PlayoutSongScope } from './playout-song-scope';
import { isRadioOnlyEngineOff } from './engine-availability';
import { ActorContext } from '../auth/actor-context';
import { radioSettingsChangeSummary } from '../operator-change/operator-change-summary';
import {
  PalazzoMachineClient,
  PalazzoMachineError,
  type PalazzoIntroCommand,
  type PalazzoSongSegue,
  type PalazzoSongLoudness,
  validateSongLoudness,
  validateSongSegue,
} from './palazzo-machine.client';
import {
  describeAcceptedMediaUrl,
  isLocalMediaUrl,
  localMediaEnvironment,
} from '../config/local-media';
import type { PalazzoPlaybackState } from './palazzo-contract';
import {
  MAX_WINDOW_SECONDS,
  MIN_WINDOW_SECONDS,
  SIMILARITY_MODES,
  SIMILARITY_POOLS,
} from './song-similarity.utils';

export interface RadioSettingsPayload {
  palazzoUrl?: string;
  listenerUrl?: string | null;
  bumperEnabled?: boolean;
  bumperInterval?: number | null;
  bumperInstantIds?: number[];
  bumperMode?: 'sequential' | 'random';
  enabled?: boolean;
  segueMode?: string;
  similarityMode?: string;
  similarityThreshold?: number;
  similarityWindowSeconds?: number;
  similarityPool?: string;
}

export interface RadioMixerPayload {
  mainVolume: number;
  songVolume: number;
  instantVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
}

/**
 * Palazzo refused an instant (gaulatti/alcantara#274). The answer is the same
 * 502 as before; `retryable` is true only when Palazzo answered 409 (its
 * `automation is not ready` answer, given until its lifecycle is ready after a
 * restart), so a caller can retry that one case and never one whose outcome is
 * unknown (a timeout or a network error carries no answer).
 */
/**
 * What a failed Palazzo command tells the operator. Only an answer from Palazzo that refuses the command reads as
 * "rejected". A command Alcántara refused before sending (a rejection with no HTTP status: the address is not
 * approved or the program ID is invalid), a server or gateway error, no answer, and an answer that does not
 * confirm the command each say so (found in the engine-outage walk, gaulatti/alcantara#703).
 */
export function palazzoCommandFailure(
  action: string,
  error: unknown,
): BadGatewayException {
  const machine = error instanceof PalazzoMachineError ? error : null;
  const reason = machine?.reason ?? 'unavailable';
  const status = machine?.status;
  let message = `Palazzo rejected the ${action}`;
  if (reason === 'unavailable')
    message = `Palazzo did not answer; the ${action} was not confirmed`;
  else if (reason === 'malformed')
    message = `Palazzo's answer to the ${action} did not confirm it`;
  else if (reason === 'rejected' && status === undefined)
    message = `The ${action} was not sent to Palazzo: Alcántara refused it`;
  else if (status !== undefined && status >= 500)
    message = `Palazzo answered the ${action} with an error; it was not confirmed`;
  return new BadGatewayException(message);
}

export class PalazzoInstantRefusedException extends BadGatewayException {
  constructor(readonly retryable: boolean) {
    super('Palazzo rejected the instant');
  }
}

@Injectable()
export class RadioService {
  private readonly logger = new Logger(RadioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly palazzo: PalazzoMachineClient,
    private readonly config: ConfigService,
    private readonly metrics: RadioMetricsService,
    @Optional() private readonly songScope?: PlayoutSongScope,
  ) {}

  async getRecoveryStatus(programId: string) {
    const settings = await this.requireRadioSettings(programId);
    let automation: Awaited<ReturnType<PalazzoMachineClient['getAutomation']>>;
    try {
      automation = await this.palazzo.getAutomation(
        this.palazzoUrl(settings),
        programId,
      );
    } catch {
      return {
        selectedSongIds: settings.fillerSongIds,
        preparedVersion: settings.fillerVersion,
        automation: null,
        connection: 'unavailable' as const,
      };
    }
    return {
      selectedSongIds: settings.fillerSongIds,
      preparedVersion: settings.fillerVersion,
      automation,
      connection: 'connected' as const,
    };
  }

  async prepareRecoveryPlaylist(programId: string, songIds: number[]) {
    try {
      const result = await this.prepareRecoveryPlaylistInner(
        programId,
        songIds,
      );
      this.metrics.recordRecoveryPreparation('ready');
      return result;
    } catch (error) {
      this.metrics.recordRecoveryPreparation('failed');
      throw error;
    }
  }

  private async prepareRecoveryPlaylistInner(
    programId: string,
    songIds: number[],
  ) {
    if (
      !Array.isArray(songIds) ||
      songIds.length < 1 ||
      songIds.length > 100 ||
      new Set(songIds).size !== songIds.length ||
      songIds.some((id) => !Number.isInteger(id) || id < 1)
    ) {
      throw new BadRequestException('select 1 to 100 distinct catalog songs');
    }
    // Once the program radio filler (gaulatti/alcantara#126) is configured,
    // it alone writes the radio filler; this legacy writer stays as before
    // for every program without one.
    if (await this.programRadioFillerVersion(programId)) {
      throw new ConflictException(
        'the radio filler is managed by the program filler configuration',
      );
    }
    const settings = await this.requireRadioSettings(programId);
    const songs = await this.prisma.song.findMany({
      where: { id: { in: songIds } },
      select: { id: true, enabled: true, audioUrl: true },
    });
    const byId = new Map(songs.map((song) => [song.id, song]));
    const ordered = songIds.map((id) => byId.get(id));
    if (ordered.some((song) => !song?.enabled || !song.audioUrl.trim()))
      throw new BadRequestException(
        'every recovery song must be enabled and have audio',
      );
    const bucket = this.config.get<string>('MEDIA_S3_BUCKET')?.trim();
    if (!bucket)
      throw new BadRequestException('managed media bucket is unavailable');
    const assets = [] as Array<{
      id: string;
      sha256: string;
      downloadUrl: string;
    }>;
    for (const song of ordered) {
      const downloadUrl = song!.audioUrl;
      let url: URL;
      try {
        url = new URL(downloadUrl);
      } catch {
        throw new BadRequestException(
          `recovery song ${song!.id} has no absolute audio URL; it needs ${describeAcceptedMediaUrl(localMediaEnvironment(this.config))}`,
        );
      }
      const isManagedBucketUrl =
        url.protocol === 'https:' &&
        [
          `${bucket}.s3.amazonaws.com`,
          `${bucket}.s3.${this.config.get<string>('AWS_REGION')}.amazonaws.com`,
        ].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port;
      // Outside production only, the Compose stack's local media store
      // (gaulatti/alcantara#206).
      if (
        !isManagedBucketUrl &&
        !isLocalMediaUrl(url, localMediaEnvironment(this.config))
      ) {
        throw new BadRequestException(
          `recovery song ${song!.id} audio must be ${describeAcceptedMediaUrl(localMediaEnvironment(this.config))}`,
        );
      }
      const response = await fetch(downloadUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      }).catch(() => {
        throw new BadRequestException('recovery audio could not be read');
      });
      if (!response.ok || !response.body)
        throw new BadRequestException('recovery audio could not be read');
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 512 * 1024 * 1024) {
            await response.body.cancel().catch(() => undefined);
            throw new BadRequestException('recovery audio exceeds 512 MiB');
          }
          hash.update(chunk);
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadGatewayException('recovery audio could not be read');
      }
      if (bytes === 0) throw new BadRequestException('recovery audio is empty');
      assets.push({
        id: `song-${song!.id}`,
        sha256: hash.digest('hex'),
        downloadUrl,
      });
    }
    const version = `filler-${randomUUID()}`;
    try {
      await this.palazzo.prepareFiller(
        this.palazzoUrl(settings),
        programId,
        version,
        assets,
      );
    } catch {
      throw new BadGatewayException(
        'Palazzo could not prepare the recovery playlist',
      );
    }
    await this.prisma.radioSettings.update({
      where: { id: settings.id },
      data: { fillerSongIds: songIds, fillerVersion: version },
    });
    return this.getRecoveryStatus(programId);
  }

  async setRecoveryAutomation(programId: string, action: 'start' | 'stop') {
    const settings = await this.requireRadioSettings(programId);
    // A configured program radio filler is the exact version Start binds to.
    const programFiller = await this.programRadioFillerVersion(programId);
    const fillerVersion = programFiller ?? settings.fillerVersion;
    if (action === 'start' && !fillerVersion)
      throw new BadRequestException('prepare a recovery playlist first');
    let current: Awaited<ReturnType<PalazzoMachineClient['getAutomation']>>;
    try {
      current = await this.palazzo.getAutomation(
        this.palazzoUrl(settings),
        programId,
      );
    } catch {
      throw new BadGatewayException('Palazzo recovery status is unavailable');
    }
    try {
      await this.palazzo.commandAutomation(
        this.palazzoUrl(settings),
        programId,
        action,
        current.lastSequence + 1,
        randomUUID(),
        action === 'start' ? fillerVersion! : undefined,
      );
    } catch {
      throw new BadGatewayException(
        `Palazzo could not ${action} the recovery session`,
      );
    }
    if (action === 'start' && programFiller) {
      // The session's filler is now that version; it stops being pending
      // only if it still is. Each statement is atomic.
      const where = { programId, leg: 'radio' };
      const promoted = await this.prisma.fillerLeg.updateMany({
        where: { ...where, pendingVersionId: programFiller },
        data: { activeVersionId: programFiller, pendingVersionId: null },
      });
      if (promoted.count === 0) {
        await this.prisma.fillerLeg.updateMany({
          where,
          data: { activeVersionId: programFiller },
        });
      }
    }
    return this.getRecoveryStatus(programId);
  }

  /** The program radio filler version a Start binds to, if one is configured. */
  private async programRadioFillerVersion(
    programId: string,
  ): Promise<string | null> {
    const leg = await this.prisma.fillerLeg.findUnique({
      where: { programId_leg: { programId, leg: 'radio' } },
    });
    return leg?.pendingVersionId ?? leg?.activeVersionId ?? null;
  }

  /**
   * gaulatti/alcantara#609: a radio-only program plays only through its playout engine. While
   * that engine is disabled (or has no settings), a take or start would play nowhere, so it is
   * refused with 409 and `reason: "engine_unavailable"`. TV and simulcast programs, whose program
   * output plays songs itself, are not affected.
   */
  async refuseStartWhileEngineUnavailable(programId: string): Promise<void> {
    if (await isRadioOnlyEngineOff(this.prisma, programId)) {
      this.metrics.recordStartRefused('engine_unavailable');
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        reason: 'engine_unavailable',
        message:
          'The radio engine is off (disabled in settings), so nothing was taken.',
      });
    }
  }

  async getRadioSettings(programId: string) {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
      include: { radioSettings: true },
    });
    if (!state) throw new Error('Program not found');
    return state.radioSettings ?? null;
  }

  async updateRadioSettings(programId: string, data: RadioSettingsPayload) {
    try {
      const result = await this.persistRadioSettings(programId, data);
      if (data.listenerUrl !== undefined)
        this.metrics.recordListenerConfiguration('success');
      return result;
    } catch (error) {
      if (data.listenerUrl !== undefined)
        this.metrics.recordListenerConfiguration('failure');
      throw error;
    }
  }

  private async persistRadioSettings(
    programId: string,
    data: RadioSettingsPayload,
  ) {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
      select: { id: true },
    });
    if (!state) throw new Error('Program not found');
    if (data.palazzoUrl !== undefined) {
      data.palazzoUrl = this.palazzo.validateBaseUrl(data.palazzoUrl);
    }

    const bumperInterval = this.normalizeBumperInterval(data.bumperInterval);
    const bumperInstantIds = this.normalizeBumperInstantIds(
      data.bumperInstantIds,
    );
    const bumperMode = this.normalizeBumperMode(data.bumperMode);
    const listenerUrl = this.normalizeListenerUrl(data.listenerUrl);
    const segueMode = this.normalizeSegueMode(data.segueMode);
    const similarity = this.normalizeSimilarityPayload(data);
    const actor = ActorContext.current();
    const previous = actor ? await this.previousRadioSettings(state.id) : null;
    const result = await this.prisma.radioSettings.upsert({
      where: { programStateId: state.id },
      update: {
        ...(data.palazzoUrl !== undefined && { palazzoUrl: data.palazzoUrl }),
        ...(listenerUrl !== undefined && { listenerUrl }),
        ...(data.bumperEnabled !== undefined && {
          bumperEnabled: data.bumperEnabled,
        }),
        ...(data.bumperInterval !== undefined && { bumperInterval }),
        ...(data.bumperInstantIds !== undefined && { bumperInstantIds }),
        ...(data.bumperMode !== undefined && { bumperMode }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(segueMode !== undefined && { segueMode }),
        ...similarity,
      },
      create: {
        programStateId: state.id,
        palazzoUrl: data.palazzoUrl ?? 'http://palazzo:3100',
        listenerUrl: listenerUrl ?? null,
        bumperEnabled: data.bumperEnabled ?? true,
        bumperInterval: bumperInterval ?? null,
        bumperInstantIds: bumperInstantIds ?? [],
        bumperMode: bumperMode ?? 'sequential',
        enabled: data.enabled ?? false,
        segueMode: segueMode ?? 'on',
        ...similarity,
      },
    });
    // The settings write above is final. Recording who made it comes after and never blocks it: a record
    // that cannot be stored is logged and counted, and the change stands (gaulatti/alcantara#236).
    if (actor)
      await this.recordOperatorChange(programId, actor, data, previous, result);
    return result;
  }

  /** The settings row before a write, or null when there is none or it cannot be read (the write goes on). */
  private async previousRadioSettings(
    programStateId: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.prisma.radioSettings.findUnique({
        where: { programStateId },
      });
    } catch (error) {
      this.logger.warn(
        `Radio settings before the change could not be read for the operator change record: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Stores who changed on-air radio settings and what changed (field names; before and after only for
   * allowlisted enum, boolean and number settings, never a URL or key). Never throws.
   */
  private async recordOperatorChange(
    programId: string,
    actor: NonNullable<ReturnType<typeof ActorContext.current>>,
    data: RadioSettingsPayload,
    previous: Record<string, unknown> | null,
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.operatorChangeRecord.create({
        data: {
          teamId: null,
          programId,
          principal: actor.principalId,
          via: actor.via,
          client: actor.client,
          capability:
            actor.via === 'mcp'
              ? 'radio_update_settings'
              : 'radio.update-settings',
          summary: radioSettingsChangeSummary(
            data as unknown as Record<string, unknown>,
            previous,
            result,
          ),
        },
      });
      this.metrics.recordOperatorChangeRecord('recorded');
    } catch (error) {
      this.metrics.recordOperatorChangeRecord('failed');
      this.logger.warn(
        `Operator change record for radio settings of ${programId} was not stored; the change stands: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private normalizeSegueMode(value?: string): string | undefined {
    if (value === undefined) return undefined;
    if (value !== 'off' && value !== 'on') {
      throw new BadRequestException('segueMode must be off or on');
    }
    return value;
  }

  /** Rejects invalid similarity fields explicitly; absent fields stay untouched. */
  private normalizeSimilarityPayload(data: RadioSettingsPayload): {
    similarityMode?: string;
    similarityThreshold?: number;
    similarityWindowSeconds?: number;
    similarityPool?: string;
  } {
    const out: ReturnType<RadioService['normalizeSimilarityPayload']> = {};
    if (data.similarityMode !== undefined) {
      if (
        !(SIMILARITY_MODES as readonly string[]).includes(data.similarityMode)
      )
        throw new BadRequestException(
          'similarityMode must be off, shadow or on',
        );
      out.similarityMode = data.similarityMode;
    }
    if (data.similarityPool !== undefined) {
      if (
        !(SIMILARITY_POOLS as readonly string[]).includes(data.similarityPool)
      )
        throw new BadRequestException(
          'similarityPool must be sequence or catalog',
        );
      out.similarityPool = data.similarityPool;
    }
    if (data.similarityThreshold !== undefined) {
      const t = data.similarityThreshold;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < -1 || t > 1)
        throw new BadRequestException(
          'similarityThreshold must be between -1 and 1',
        );
      out.similarityThreshold = t;
    }
    if (data.similarityWindowSeconds !== undefined) {
      const w = data.similarityWindowSeconds;
      if (
        !Number.isInteger(w) ||
        w < MIN_WINDOW_SECONDS ||
        w > MAX_WINDOW_SECONDS
      )
        throw new BadRequestException(
          `similarityWindowSeconds must be an integer between ${MIN_WINDOW_SECONDS} and ${MAX_WINDOW_SECONDS}`,
        );
      out.similarityWindowSeconds = w;
    }
    return out;
  }

  private normalizeListenerUrl(value: unknown): string | null | undefined {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string')
      throw new BadRequestException(
        'listenerUrl must be a public HTTPS stream URL or null',
      );
    if (!value.trim()) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException(
        'listenerUrl must be a public HTTPS stream URL',
      );
    }
    const localHttp =
      process.env.NODE_ENV !== 'production' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !localHttp) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new BadRequestException(
        'listenerUrl must use HTTPS without credentials or a fragment',
      );
    }
    return value.trim();
  }

  private normalizeBumperInterval(
    value: number | null | undefined,
  ): number | null | undefined {
    if (value === undefined || value === null) return value;
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(
        'bumperInterval must be a positive integer or null',
      );
    }
    return value;
  }

  private normalizeBumperInstantIds(
    value: number[] | undefined,
  ): number[] | undefined {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.some((id) => !Number.isInteger(id) || id < 1)
    ) {
      throw new BadRequestException(
        'bumperInstantIds must contain positive integer IDs',
      );
    }
    return [...new Set(value)];
  }

  private normalizeBumperMode(
    value: string | undefined,
  ): 'sequential' | 'random' | undefined {
    if (value === undefined) return undefined;
    if (value !== 'sequential' && value !== 'random') {
      throw new BadRequestException('bumperMode must be sequential or random');
    }
    return value;
  }

  private palazzoUrl(settings: unknown): string {
    const value =
      settings && typeof settings === 'object' && 'palazzoUrl' in settings
        ? settings.palazzoUrl
        : undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadGatewayException('Palazzo URL is not configured');
    }
    return value.trim();
  }

  async playSong(
    programId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
    playbackRequestId?: string,
    coverUrl?: string,
    intro?: PalazzoIntroCommand,
    songId?: number,
    duration?: number,
    segue?: PalazzoSongSegue,
    loudness?: PalazzoSongLoudness,
  ): Promise<{
    ok: boolean;
    playbackRequestId?: string;
    introPlaybackId?: string | null;
  }> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) {
      // #237: a song command for a program with no radio settings is refused;
      // say so instead of answering ok:false silently.
      this.logger.warn(`Radio settings missing for program ${programId}`);
      this.metrics.recordEngineDegraded('radio_settings_missing');
      return { ok: false };
    }
    const requestId = playbackRequestId?.trim() || randomUUID();

    const {
      segue: resolvedSegue,
      loudness: resolvedLoudness,
      durationSeconds: resolvedDuration,
    } = settings.segueMode === 'on'
      ? await this.resolveSongAnalysis(
          programId,
          requestId,
          audioUrl,
          songId,
          duration,
          segue,
          loudness,
        )
      : { segue: undefined, loudness: undefined, durationSeconds: undefined };
    // With a cue group, the duration it was checked against (the caller's,
    // else the stored Song.durationMs), so Palazzo bounds and counts the tail
    // trim on the command path as it does for an announced song. Without
    // one, the command is unchanged.
    const sentDuration =
      duration ?? (resolvedSegue ? resolvedDuration : undefined);

    try {
      const result = await this.palazzo.playSong(
        this.palazzoUrl(settings),
        programId,
        {
          playbackId: requestId,
          url: audioUrl,
          title,
          artist,
          coverUrl,
          intro,
          ...(sentDuration !== undefined && { duration: sentDuration }),
          ...(resolvedSegue && { segue: resolvedSegue }),
          ...(resolvedLoudness && { loudness: resolvedLoudness }),
        },
      );
      return {
        ok: true,
        playbackRequestId: result.playbackRequestId,
        introPlaybackId: result.introPlaybackId,
      };
    } catch (error) {
      this.logMachineFailure('playSong', programId, error);
      return { ok: false, playbackRequestId: requestId };
    }
  }

  /**
   * Announces the next song to Palazzo while the current one plays (contract
   * palazzo#40 §1). Segue and loudness are resolved exactly as for the song
   * command the engine would otherwise send, and only when segueMode is on.
   * Returns `accepted`, `not_ready`, `rejected` (not announced) or
   * `unsupported` (an older Palazzo); any other failure is `rejected`.
   */
  async announceNext(
    programId: string,
    song: {
      playbackId: string;
      url: string;
      title?: string;
      artist?: string;
      coverUrl?: string;
    },
    bumper?: { playbackId: string; url: string },
  ): Promise<'accepted' | 'not_ready' | 'rejected' | 'unsupported'> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) {
      this.metrics.recordNextAnnouncement('rejected');
      return 'rejected';
    }
    const { segue, loudness } =
      settings.segueMode === 'on'
        ? await this.resolveSongAnalysis(
            programId,
            song.playbackId,
            song.url,
            undefined,
            undefined,
            undefined,
            undefined,
          )
        : { segue: undefined, loudness: undefined };
    let result: 'accepted' | 'not_ready' | 'rejected' | 'unsupported';
    try {
      result = (
        await this.palazzo.announceNext(this.palazzoUrl(settings), programId, {
          playbackId: song.playbackId,
          url: song.url,
          title: song.title,
          artist: song.artist,
          coverUrl: song.coverUrl,
          ...(segue && { segue }),
          ...(loudness && { loudness }),
          ...(bumper && { bumper }),
        })
      ).result;
    } catch (error) {
      this.logMachineFailure('announceNext', programId, error);
      result = 'rejected';
    }
    this.metrics.recordNextAnnouncement(result);
    return result;
  }

  /**
   * Withdraws the announced next song. Returns whether Palazzo removed one
   * (false when it was already on air, "too late to replace"), or null when
   * the request failed; a failure is logged.
   */
  async withdrawNext(programId: string): Promise<boolean | null> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return null;
    try {
      const { withdrawn } = await this.palazzo.withdrawNext(
        this.palazzoUrl(settings),
        programId,
      );
      this.metrics.recordNextAnnouncement('withdrawn');
      return withdrawn;
    } catch (error) {
      this.logMachineFailure('withdrawNext', programId, error);
      return null;
    }
  }

  // Segue and loudness for a song command when segueMode is on: the caller's values, else the song's stored analysis.
  // Each field group is checked with the bounds Palazzo's client enforces (validateSongSegue, validateSongLoudness)
  // plus cue-out within the song's duration, and an invalid group is dropped so the song still plays without it.
  // Analysis is never applied from an audio URL that more than one song shares. Every drop is counted and logged
  // once per song, without the audio URL.
  private async resolveSongAnalysis(
    programId: string,
    playbackRequestId: string,
    audioUrl: string,
    songId: number | undefined,
    duration: number | undefined,
    segue: PalazzoSongSegue | undefined,
    loudness: PalazzoSongLoudness | undefined,
  ): Promise<{
    segue?: PalazzoSongSegue;
    loudness?: PalazzoSongLoudness;
    durationSeconds?: number;
  }> {
    const drops: AnalysisDropResult[] = [];
    let durationSeconds = duration;
    // The cue group's shape, counted once the group is final (#234); a
    // caller-supplied segue is not an analysis group and is not counted.
    let shape: CueGroupShape | null = null;
    if (!segue && !loudness) {
      try {
        const song = await this.findSongForAnalysis(
          programId,
          audioUrl,
          songId,
          drops,
        );
        // A song sent without its analysis is counted too (gaulatti/alcantara#255):
        // no library song with a media asset, or an asset not (yet) analysed.
        if (!song?.assetId && !drops.includes('ambiguous-match')) {
          drops.push('no-asset');
        }
        if (song?.assetId) {
          if (
            durationSeconds === undefined &&
            typeof song.durationMs === 'number'
          ) {
            durationSeconds = song.durationMs / 1000;
          }
          const analysis = await this.prisma.mediaAssetAnalysis.findUnique({
            where: { assetId: song.assetId },
          });
          if (analysis && analysis.status === 'success') {
            const cues = cueGroupFrom(
              analysis.cueInSeconds,
              analysis.cueOutSeconds,
              durationSeconds,
              drops,
            );
            shape = cues?.shape ?? 'none';
            if (cues) {
              segue = {
                cueInSeconds: cues.cueInSeconds,
                cueOutSeconds: cues.cueOutSeconds,
                fadeInSeconds: analysis.fadeInSeconds ?? 0,
                fadeOutSeconds: analysis.fadeOutSeconds ?? 0,
                overlapSeconds: analysis.overlapSeconds ?? 0,
              };
            }
            if (
              analysis.integratedLufs !== null &&
              analysis.truePeakDbtp !== null
            ) {
              loudness = {
                integratedLufs: analysis.integratedLufs,
                truePeakDbtp: analysis.truePeakDbtp,
              };
            }
          } else {
            // Missing, pending or failed analysis.
            drops.push('not-analyzed');
          }
        }
      } catch {
        // A failed analysis lookup never blocks playback: the song plays without segue and loudness.
        drops.push('lookup-failed');
      }
    }
    if (segue) {
      try {
        validateSongSegue(segue);
        if (
          durationSeconds !== undefined &&
          segue.cueOutSeconds > durationSeconds
        ) {
          segue = undefined;
          drops.push('segue-beyond-duration');
        }
      } catch {
        segue = undefined;
        drops.push('segue-invalid');
      }
    }
    if (loudness) {
      try {
        validateSongLoudness(loudness);
      } catch {
        loudness = undefined;
        drops.push('loudness-invalid');
      }
    }
    if (shape !== null) this.metrics.recordCueGroup(segue ? shape : 'none');
    for (const drop of drops) this.metrics.recordAnalysisDrop(drop);
    if (drops.length) {
      this.logger.warn({
        event: 'radio.song_analysis_dropped',
        programId,
        playbackRequestId,
        ...(songId !== undefined && { songId }),
        reasons: drops,
      });
    }
    return {
      ...(segue && { segue }),
      ...(loudness && { loudness }),
      ...(durationSeconds !== undefined && { durationSeconds }),
    };
  }

  // The song whose analysis applies: by id when given, else by audio URL only when exactly one song has it.
  private async findSongForAnalysis(
    programId: string,
    audioUrl: string,
    songId: number | undefined,
    drops: AnalysisDropResult[],
  ): Promise<{ assetId: string | null; durationMs: number | null } | null> {
    if (songId) {
      const byId = (db: PrismaService) =>
        db.song.findUnique({
          where: { id: songId },
          select: { assetId: true, durationMs: true },
        });
      return this.songScope
        ? this.songScope.read('analysis', programId, byId, (song) => !!song)
        : byId(this.prisma);
    }
    const byUrl = (db: PrismaService) =>
      db.song.findMany({
        where: { audioUrl },
        select: { assetId: true, durationMs: true },
        take: 2,
      });
    const songs = this.songScope
      ? await this.songScope.read(
          'analysis',
          programId,
          byUrl,
          (rows) => rows.length > 0,
        )
      : await byUrl(this.prisma);
    if (songs.length > 1) {
      drops.push('ambiguous-match');
      return null;
    }
    return songs[0] ?? null;
  }

  async stopSong(programId: string): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    // Outside the try: a missing address is Alcántara's configuration, not a Palazzo failure.
    const url = this.palazzoUrl(settings);
    try {
      await this.palazzo.stopSong(url, programId);
    } catch (error) {
      this.logMachineFailure('stopSong', programId, error);
      throw palazzoCommandFailure('song stop', error);
    }
  }

  async playInstant(
    programId: string,
    audioUrl: string,
    volume?: number,
    playbackRequestId?: string,
  ): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    const requestId = playbackRequestId?.trim() || randomUUID();
    try {
      await this.palazzo.playInstant(this.palazzoUrl(settings), programId, {
        playbackId: requestId,
        url: audioUrl,
        volume,
      });
    } catch (error) {
      this.logMachineFailure('playInstant', programId, error);
      throw new PalazzoInstantRefusedException(
        error instanceof PalazzoMachineError &&
          error.reason === 'rejected' &&
          error.status === 409,
      );
    }
  }

  async updateMixer(
    programId: string,
    mixer: RadioMixerPayload,
  ): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    const url = this.palazzoUrl(settings);
    try {
      await this.palazzo.updateMixer(url, programId, mixer);
    } catch (error) {
      this.logMachineFailure('updateMixer', programId, error);
      throw palazzoCommandFailure('radio mixer update', error);
    }
  }

  async getPlaybackState(programId: string): Promise<PalazzoPlaybackState> {
    const settings = await this.requireRadioSettings(programId);
    try {
      return await this.palazzo.getPlaybackState(
        this.palazzoUrl(settings),
        programId,
      );
    } catch (error) {
      this.logMachineFailure('getPlaybackState', programId, error);
      throw new BadGatewayException('Palazzo playback state is unavailable');
    }
  }

  async stopAllInstants(programId: string): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    const url = this.palazzoUrl(settings);
    try {
      await this.palazzo.stopInstants(url, programId);
    } catch (error) {
      this.logMachineFailure('stopAllInstants', programId, error);
      throw palazzoCommandFailure('instant stop', error);
    }
  }

  async getPalazzoStatus(programId: string): Promise<{
    running: boolean;
    uptime: null;
  }> {
    const state = await this.getPlaybackState(programId);
    return {
      running:
        state.liquidsoap.running &&
        state.liquidsoap.connected &&
        state.icecast.connected,
      uptime: null,
    };
  }

  private async requireRadioSettings(programId: string) {
    const settings = await this.getRadioSettings(programId);
    if (!settings) {
      throw new BadGatewayException('Radio settings are unavailable');
    }
    return settings;
  }

  private logMachineFailure(
    operation: string,
    programId: string,
    error: unknown,
  ): void {
    const reason =
      error instanceof PalazzoMachineError ? error.reason : 'unavailable';
    this.logger.error({
      event: 'palazzo.machine.failed',
      operation,
      programId,
      reason,
    });
  }
}

/**
 * Seconds a cue point may trim from one edge of a song (gaulatti/alcantara#234,
 * the same bound as Palazzo's). Catalog on 2026-11-21: tail silence max 8.01 s,
 * head max 9.81 s.
 */
export const CUE_EDGE_BOUND_SECONDS = 10;

/**
 * The cue group to send for a song's measured edges (gaulatti/alcantara#234).
 * Palazzo trims when it receives a full group, so a single measured edge is
 * sent with the other filled: a missing cue-in is 0, a missing cue-out is the
 * song's duration (the same duration Palazzo validates against). Each edge is
 * bounded on its own: a cue that would trim more than CUE_EDGE_BOUND_SECONDS,
 * is not finite or is negative is not applied (that edge is filled instead)
 * and counted. Without a known duration a song keeps today's behaviour: both
 * measured cues, unbounded (Palazzo's own bound applies at play time), or
 * none. Null when no edge is left to trim.
 */
export function cueGroupFrom(
  cueIn: number | null,
  cueOut: number | null,
  durationSeconds: number | undefined,
  drops: AnalysisDropResult[],
): {
  cueInSeconds: number;
  cueOutSeconds: number;
  shape: Exclude<CueGroupShape, 'none'>;
} | null {
  const known =
    durationSeconds !== undefined && Number.isFinite(durationSeconds);
  if (!known) {
    // Without a duration neither the fill nor the tail bound is possible: a
    // song keeps exactly today's behaviour, both measured cues or none.
    return cueIn !== null && cueOut !== null
      ? { cueInSeconds: cueIn, cueOutSeconds: cueOut, shape: 'both' }
      : null;
  }
  const duration = durationSeconds as number;
  let head = cueIn;
  let tail = cueOut;
  if (
    head !== null &&
    !(Number.isFinite(head) && head >= 0 && head <= CUE_EDGE_BOUND_SECONDS)
  ) {
    drops.push('segue-edge-bound');
    head = null;
  }
  if (
    tail !== null &&
    !(
      Number.isFinite(tail) &&
      tail >= 0 &&
      // A cue-out past the stored duration (the file a little longer than
      // Song.durationMs) is no tail trim: the duration stands in for it, and
      // the head is kept rather than the whole group being dropped later.
      tail <= duration &&
      duration - tail <= CUE_EDGE_BOUND_SECONDS
    )
  ) {
    drops.push('segue-edge-bound');
    tail = null;
  }
  if (head === null && tail === null) return null;
  return {
    cueInSeconds: head ?? 0,
    cueOutSeconds: tail ?? duration,
    shape:
      head !== null && tail !== null
        ? 'both'
        : head === null
          ? 'head_filled'
          : 'tail_filled',
  };
}
