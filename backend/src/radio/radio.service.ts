import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import {
  PalazzoMachineClient,
  PalazzoMachineError,
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
  ) {}

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
  ): Promise<{ ok: boolean; playbackRequestId?: string }> {
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
        },
      );
      return {
        ok: true,
        playbackRequestId: result.playbackRequestId,
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
