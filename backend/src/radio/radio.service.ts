import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface RadioSettingsPayload {
  palazzoUrl?: string;
  enabled?: boolean;
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

    const result = await this.prisma.radioSettings.upsert({
      where: { programStateId: state.id },
      update: {
        ...(data.palazzoUrl !== undefined && { palazzoUrl: data.palazzoUrl }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
      create: {
        programStateId: state.id,
        palazzoUrl: data.palazzoUrl ?? 'http://palazzo:3100',
        enabled: data.enabled ?? false,
      },
    });
    return result;
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
  ): Promise<{ ok: boolean; playbackRequestId?: string }> {
    const settings = await this.getRadioSettings(programId);
    if (!settings) return { ok: false };
    const url = this.palazzoUrl(settings);
    try {
      const res = await fetch(`${url}/song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: audioUrl, title, artist, playbackRequestId }),
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json().catch(() => null)) as
        | { playbackRequestId?: string }
        | null;
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

  async getPlaybackState(
    programId: string,
  ): Promise<unknown | null> {
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
      await fetch(`${this.palazzoUrl(settings)}/instant/stop`, { method: 'POST' });
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
