import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

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

  private palazzoUrl(settings: any): string {
    return (settings?.palazzoUrl || 'http://palazzo:3100').replace(/\/+$/, '');
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
    const url = this.palazzoUrl(settings);
    try {
      const res = await fetch(`${url}/song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: audioUrl,
          title,
          artist,
          coverUrl,
          playbackRequestId,
        }),
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json().catch(() => null)) as {
        playbackRequestId?: string;
      } | null;
      return {
        ok: true,
        playbackRequestId:
          typeof body?.playbackRequestId === 'string'
            ? body.playbackRequestId
            : playbackRequestId,
      };
    } catch (err) {
      this.logger.error(`playSong failed: ${err}`);
      return { ok: false };
    }
  }

  async stopSong(programId: string): Promise<void> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return;
    try {
      await fetch(`${this.palazzoUrl(settings)}/song/stop`, { method: 'POST' });
    } catch (err) {
      this.logger.error(`stopSong failed: ${err}`);
    }
  }

  async playInstant(
    programId: string,
    audioUrl: string,
    volume?: number,
    playbackRequestId?: string,
  ): Promise<void> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return;
    try {
      await fetch(`${this.palazzoUrl(settings)}/instant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: audioUrl, volume, playbackRequestId }),
      });
    } catch (err) {
      this.logger.error(`playInstant failed: ${err}`);
    }
  }

  async updateMixer(
    programId: string,
    mixer: RadioMixerPayload,
  ): Promise<void> {
    const settings = await this.getRadioSettings(programId);
    if (!settings)
      throw new BadGatewayException('Radio settings are unavailable');
    try {
      const res = await fetch(`${this.palazzoUrl(settings)}/mixer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mixer),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      this.logger.error(`updateMixer failed: ${err}`);
      throw new BadGatewayException('Palazzo rejected the radio mixer update');
    }
  }

  async getPlaybackState(programId: string): Promise<unknown | null> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return null;
    try {
      const res = await fetch(`${this.palazzoUrl(settings)}/playback/state`);
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }

  async stopAllInstants(programId: string): Promise<void> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return;
    try {
      await fetch(`${this.palazzoUrl(settings)}/instant/stop`, {
        method: 'POST',
      });
    } catch (err) {
      this.logger.error(`stopAllInstants failed: ${err}`);
    }
  }

  async getPalazzoStatus(programId: string): Promise<unknown | null> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return null;
    try {
      const res = await fetch(`${this.palazzoUrl(settings)}/status`);
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }
}
