import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RadioMetricsService } from './radio-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  PalazzoMachineClient,
  PalazzoMachineError,
  type PalazzoIntroCommand,
} from './palazzo-machine.client';
import type { PalazzoPlaybackState } from './palazzo-contract';

export interface RadioSettingsPayload {
  palazzoUrl?: string;
  bumperEnabled?: boolean;
  bumperInterval?: number | null;
  bumperInstantIds?: number[];
  bumperMode?: 'sequential' | 'random';
  enabled?: boolean;
}

export interface RadioMixerPayload {
  mainVolume: number;
  songVolume: number;
  instantVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
}

@Injectable()
export class RadioService {
  private readonly logger = new Logger(RadioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly palazzo: PalazzoMachineClient,
    private readonly config: ConfigService,
    private readonly metrics: RadioMetricsService,
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
        throw new BadRequestException('recovery song has an invalid URL');
      }
      if (
        url.protocol !== 'https:' ||
        ![
          `${bucket}.s3.amazonaws.com`,
          `${bucket}.s3.${this.config.get<string>('AWS_REGION')}.amazonaws.com`,
        ].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      ) {
        throw new BadRequestException(
          'recovery audio must use the managed media bucket',
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
    if (action === 'start' && !settings.fillerVersion)
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
        action === 'start' ? settings.fillerVersion! : undefined,
      );
    } catch {
      throw new BadGatewayException(
        `Palazzo could not ${action} the recovery session`,
      );
    }
    return this.getRecoveryStatus(programId);
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
    const result = await this.prisma.radioSettings.upsert({
      where: { programStateId: state.id },
      update: {
        ...(data.palazzoUrl !== undefined && { palazzoUrl: data.palazzoUrl }),
        ...(data.bumperEnabled !== undefined && {
          bumperEnabled: data.bumperEnabled,
        }),
        ...(data.bumperInterval !== undefined && { bumperInterval }),
        ...(data.bumperInstantIds !== undefined && { bumperInstantIds }),
        ...(data.bumperMode !== undefined && { bumperMode }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
      create: {
        programStateId: state.id,
        palazzoUrl: data.palazzoUrl ?? 'http://palazzo:3100',
        bumperEnabled: data.bumperEnabled ?? false,
        bumperInterval: bumperInterval ?? null,
        bumperInstantIds: bumperInstantIds ?? [],
        bumperMode: bumperMode ?? 'sequential',
        enabled: data.enabled ?? false,
      },
    });
    return result;
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
  ): Promise<{
    ok: boolean;
    playbackRequestId?: string;
    introPlaybackId?: string | null;
  }> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return { ok: false };
    const requestId = playbackRequestId?.trim() || randomUUID();
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

  async stopSong(programId: string): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    try {
      await this.palazzo.stopSong(this.palazzoUrl(settings), programId);
    } catch (error) {
      this.logMachineFailure('stopSong', programId, error);
      throw new BadGatewayException('Palazzo rejected the song stop');
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
      throw new BadGatewayException('Palazzo rejected the instant');
    }
  }

  async updateMixer(
    programId: string,
    mixer: RadioMixerPayload,
  ): Promise<void> {
    const settings = await this.requireRadioSettings(programId);
    try {
      await this.palazzo.updateMixer(
        this.palazzoUrl(settings),
        programId,
        mixer,
      );
    } catch (error) {
      this.logMachineFailure('updateMixer', programId, error);
      throw new BadGatewayException('Palazzo rejected the radio mixer update');
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
    try {
      await this.palazzo.stopInstants(this.palazzoUrl(settings), programId);
    } catch (error) {
      this.logMachineFailure('stopAllInstants', programId, error);
      throw new BadGatewayException('Palazzo rejected the instant stop');
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
