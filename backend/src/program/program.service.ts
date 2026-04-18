import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PrismaService } from '../prisma.service';

export interface ProgramAudioMeterChannel {
  vu: number;
  peak: number;
  peakHold: number;
}

export interface ProgramAudioMeterLevels {
  song: ProgramAudioMeterChannel;
  instants: ProgramAudioMeterChannel;
  sceneInstant: ProgramAudioMeterChannel;
  main: ProgramAudioMeterChannel;
  updatedAt: string;
}

interface BroadcastMixerChannel {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface ProgramAudioMixerSettings {
  mainMasterVolume: number;
  songMasterVolume: number;
  instantMasterVolume: number;
  sceneInstantMasterVolume: number;
  streamMasterVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
  sceneInstantMuted: boolean;
  streamMuted: boolean;
  songSolo: boolean;
  instantSolo: boolean;
  sceneInstantSolo: boolean;
  streamSolo: boolean;
  mixerChannels: BroadcastMixerChannel[];
}

export interface ProgramSceneInstantPlayback {
  programId: string;
  sceneId: number | null;
  instantId: number | null;
  isPlaying: boolean;
  instant: {
    id: number;
    name: string;
    audioUrl: string;
    volume: number;
  } | null;
  startedAt: string | null;
  updatedAt: string;
}

type ProgramUpdateTopic =
  | 'state'
  | 'audioBus'
  | 'audioMeter'
  | 'songPlayback'
  | 'sceneInstant';

@Injectable()
export class ProgramService {
  private static readonly DEFAULT_PROGRAM_ID = 'main';
  private static readonly BROADCAST_SETTINGS_ID = 1;
  private static readonly SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS = 450;
  private broadcastSettingsColumnsEnsured = false;
  private eventSubjects = new Map<string, Subject<any>>();
  private readonly topicVersionByProgramId: Record<
    ProgramUpdateTopic,
    Map<string, number>
  > = {
    state: new Map<string, number>(),
    audioBus: new Map<string, number>(),
    audioMeter: new Map<string, number>(),
    songPlayback: new Map<string, number>(),
    sceneInstant: new Map<string, number>(),
  };
  private globalBroadcastVersion = 0;
  private stagedSceneByProgramId = new Map<string, number | null>();
  private programAudioMeterByProgramId = new Map<
    string,
    ProgramAudioMeterLevels
  >();
  private programSceneInstantPlaybackByProgramId = new Map<
    string,
    ProgramSceneInstantPlayback
  >();
  private programSongPlaybackByProgramId = new Map<
    string,
    {
      token: string;
      audioUrl: string;
      progress: number;
      currentTimeMs: number;
      durationMs: number | null;
      isPlaying: boolean;
      updatedAt: string;
    }
  >();
  private eventListeners = new Set<
    (event: {
      scope: 'program' | 'global';
      programId: string | null;
      data: any;
    }) => void
  >();

  constructor(private prisma: PrismaService) {}

  private createDefaultBroadcastMixerChannels(): BroadcastMixerChannel[] {
    return [
      { id: 'song', name: 'Song', volume: 1, muted: false, solo: false },
      { id: 'stream', name: 'Stream', volume: 1, muted: false, solo: false },
      {
        id: 'instants',
        name: 'Instants',
        volume: 1,
        muted: false,
        solo: false,
      },
      {
        id: 'sceneInstant',
        name: 'Scene Instant',
        volume: 1,
        muted: false,
        solo: false,
      },
    ];
  }

  private createDefaultProgramAudioMixerSettings(): ProgramAudioMixerSettings {
    return {
      mainMasterVolume: 1,
      songMasterVolume: 1,
      instantMasterVolume: 1,
      sceneInstantMasterVolume: 1,
      streamMasterVolume: 1,
      songMuted: false,
      instantMuted: false,
      sceneInstantMuted: false,
      streamMuted: false,
      songSolo: false,
      instantSolo: false,
      sceneInstantSolo: false,
      streamSolo: false,
      mixerChannels: this.createDefaultBroadcastMixerChannels(),
    };
  }

  private createEmptyProgramSceneInstantPlayback(
    programId: string,
  ): ProgramSceneInstantPlayback {
    return {
      programId,
      sceneId: null,
      instantId: null,
      isPlaying: false,
      instant: null,
      startedAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private coerceMasterVolume(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(0, Math.min(1, value));
  }

  private coerceMixerToggle(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    return fallback;
  }

  private normalizeBroadcastMixerChannels(
    value: unknown,
    fallback: BroadcastMixerChannel[],
  ): BroadcastMixerChannel[] {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const byId = new Map<string, BroadcastMixerChannel>();
    for (const fallbackChannel of fallback) {
      byId.set(fallbackChannel.id, { ...fallbackChannel });
    }

    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id) {
        continue;
      }
      const name =
        typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : (byId.get(id)?.name ?? id);
      const volume = this.coerceMasterVolume(
        record.volume,
        byId.get(id)?.volume ?? 1,
      );
      const muted = this.coerceMixerToggle(
        record.muted,
        byId.get(id)?.muted ?? false,
      );
      const solo = this.coerceMixerToggle(
        record.solo,
        byId.get(id)?.solo ?? false,
      );
      byId.set(id, { id, name, volume, muted, solo });
    }

    return [...byId.values()];
  }

  private getBroadcastMixerChannel(
    channels: BroadcastMixerChannel[],
    id: string,
  ): BroadcastMixerChannel {
    const matched = channels.find((channel) => channel.id === id);
    if (matched) {
      return matched;
    }
    return {
      id,
      name: id,
      volume: 1,
      muted: false,
      solo: false,
    };
  }

  private withResolvedBroadcastMixerChannels<T extends Record<string, any>>(
    settings: T,
  ): T & { mixerChannels: BroadcastMixerChannel[] } {
    const defaultChannels = this.createDefaultBroadcastMixerChannels();
    const legacyChannels: BroadcastMixerChannel[] = [
      {
        id: 'song',
        name: 'Song',
        volume: this.coerceMasterVolume(settings.songMasterVolume, 1),
        muted: this.coerceMixerToggle(settings.songMuted, false),
        solo: this.coerceMixerToggle(settings.songSolo, false),
      },
      {
        id: 'stream',
        name: 'Stream',
        volume: this.coerceMasterVolume(settings.streamMasterVolume, 1),
        muted: this.coerceMixerToggle(settings.streamMuted, false),
        solo: this.coerceMixerToggle(settings.streamSolo, false),
      },
      {
        id: 'instants',
        name: 'Instants',
        volume: this.coerceMasterVolume(settings.instantMasterVolume, 1),
        muted: this.coerceMixerToggle(settings.instantMuted, false),
        solo: this.coerceMixerToggle(settings.instantSolo, false),
      },
      {
        id: 'sceneInstant',
        name: 'Scene Instant',
        volume: this.coerceMasterVolume(settings.sceneInstantMasterVolume, 1),
        muted: this.coerceMixerToggle(settings.sceneInstantMuted, false),
        solo: this.coerceMixerToggle(settings.sceneInstantSolo, false),
      },
    ];

    const normalizedChannels = this.normalizeBroadcastMixerChannels(
      settings.mixerChannels,
      legacyChannels.length ? legacyChannels : defaultChannels,
    );
    const song = this.getBroadcastMixerChannel(normalizedChannels, 'song');
    const stream = this.getBroadcastMixerChannel(normalizedChannels, 'stream');
    const instants = this.getBroadcastMixerChannel(
      normalizedChannels,
      'instants',
    );
    const sceneInstant = this.getBroadcastMixerChannel(
      normalizedChannels,
      'sceneInstant',
    );

    return {
      ...settings,
      mixerChannels: normalizedChannels,
      songMasterVolume: song.volume,
      streamMasterVolume: stream.volume,
      instantMasterVolume: instants.volume,
      sceneInstantMasterVolume: sceneInstant.volume,
      songMuted: song.muted,
      streamMuted: stream.muted,
      instantMuted: instants.muted,
      sceneInstantMuted: sceneInstant.muted,
      songSolo: song.solo,
      streamSolo: stream.solo,
      instantSolo: instants.solo,
      sceneInstantSolo: sceneInstant.solo,
    };
  }

  private withResolvedProgramAudioMixerSettings(
    value: unknown,
    fallback: ProgramAudioMixerSettings = this.createDefaultProgramAudioMixerSettings(),
  ): ProgramAudioMixerSettings {
    const record =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const fallbackChannels = this.normalizeBroadcastMixerChannels(
      fallback.mixerChannels,
      this.createDefaultBroadcastMixerChannels(),
    );
    let mixerChannels = this.normalizeBroadcastMixerChannels(
      record.mixerChannels,
      fallbackChannels,
    );

    const applyChannelPatch = (
      channelId: 'song' | 'stream' | 'instants' | 'sceneInstant',
      patch: { volume?: number; muted?: boolean; solo?: boolean },
    ) => {
      mixerChannels = mixerChannels.map((channel) => {
        if (channel.id !== channelId) {
          return channel;
        }
        return {
          ...channel,
          ...patch,
        };
      });
    };

    if ('songMasterVolume' in record) {
      applyChannelPatch('song', {
        volume: this.coerceMasterVolume(
          record.songMasterVolume,
          fallback.songMasterVolume,
        ),
      });
    }
    if ('instantMasterVolume' in record) {
      applyChannelPatch('instants', {
        volume: this.coerceMasterVolume(
          record.instantMasterVolume,
          fallback.instantMasterVolume,
        ),
      });
    }
    if ('streamMasterVolume' in record) {
      applyChannelPatch('stream', {
        volume: this.coerceMasterVolume(
          record.streamMasterVolume,
          fallback.streamMasterVolume,
        ),
      });
    }
    if ('sceneInstantMasterVolume' in record) {
      applyChannelPatch('sceneInstant', {
        volume: this.coerceMasterVolume(
          record.sceneInstantMasterVolume,
          fallback.sceneInstantMasterVolume,
        ),
      });
    }
    if ('songMuted' in record) {
      applyChannelPatch('song', {
        muted: this.coerceMixerToggle(record.songMuted, fallback.songMuted),
      });
    }
    if ('instantMuted' in record) {
      applyChannelPatch('instants', {
        muted: this.coerceMixerToggle(
          record.instantMuted,
          fallback.instantMuted,
        ),
      });
    }
    if ('streamMuted' in record) {
      applyChannelPatch('stream', {
        muted: this.coerceMixerToggle(record.streamMuted, fallback.streamMuted),
      });
    }
    if ('sceneInstantMuted' in record) {
      applyChannelPatch('sceneInstant', {
        muted: this.coerceMixerToggle(
          record.sceneInstantMuted,
          fallback.sceneInstantMuted,
        ),
      });
    }
    if ('songSolo' in record) {
      applyChannelPatch('song', {
        solo: this.coerceMixerToggle(record.songSolo, fallback.songSolo),
      });
    }
    if ('instantSolo' in record) {
      applyChannelPatch('instants', {
        solo: this.coerceMixerToggle(record.instantSolo, fallback.instantSolo),
      });
    }
    if ('streamSolo' in record) {
      applyChannelPatch('stream', {
        solo: this.coerceMixerToggle(record.streamSolo, fallback.streamSolo),
      });
    }
    if ('sceneInstantSolo' in record) {
      applyChannelPatch('sceneInstant', {
        solo: this.coerceMixerToggle(
          record.sceneInstantSolo,
          fallback.sceneInstantSolo,
        ),
      });
    }

    const song = this.getBroadcastMixerChannel(mixerChannels, 'song');
    const stream = this.getBroadcastMixerChannel(mixerChannels, 'stream');
    const instants = this.getBroadcastMixerChannel(mixerChannels, 'instants');
    const sceneInstant = this.getBroadcastMixerChannel(
      mixerChannels,
      'sceneInstant',
    );

    return {
      mainMasterVolume: this.coerceMasterVolume(
        record.mainMasterVolume,
        fallback.mainMasterVolume,
      ),
      songMasterVolume: song.volume,
      instantMasterVolume: instants.volume,
      sceneInstantMasterVolume: sceneInstant.volume,
      streamMasterVolume: stream.volume,
      songMuted: song.muted,
      instantMuted: instants.muted,
      sceneInstantMuted: sceneInstant.muted,
      streamMuted: stream.muted,
      songSolo: song.solo,
      instantSolo: instants.solo,
      sceneInstantSolo: sceneInstant.solo,
      streamSolo: stream.solo,
      mixerChannels,
    };
  }

  private async ensureBroadcastSettingsColumns() {
    if (this.broadcastSettingsColumnsEnsured) {
      return;
    }

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE "BroadcastSettings"
      ADD COLUMN IF NOT EXISTS "mixerChannels" JSONB,
      ADD COLUMN IF NOT EXISTS "streamMasterVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "streamMuted" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "streamSolo" BOOLEAN NOT NULL DEFAULT false;
    `);

    this.broadcastSettingsColumnsEnsured = true;
  }

  private async ensureBroadcastSettings() {
    await this.ensureBroadcastSettingsColumns();

    return this.prisma.broadcastSettings.upsert({
      where: { id: ProgramService.BROADCAST_SETTINGS_ID },
      update: {},
      create: {
        id: ProgramService.BROADCAST_SETTINGS_ID,
        timeOverrideEnabled: false,
        mixerChannels: this.createDefaultBroadcastMixerChannels() as any,
        mainMasterVolume: 1,
        songMasterVolume: 1,
        instantMasterVolume: 1,
        streamMasterVolume: 1,
        songMuted: false,
        instantMuted: false,
        streamMuted: false,
        songSolo: false,
        instantSolo: false,
        streamSolo: false,
      },
    });
  }

  async getBroadcastSettings() {
    const settings = await this.ensureBroadcastSettings();
    return {
      ...this.withResolvedBroadcastMixerChannels(settings as any),
      version: this.getGlobalBroadcastVersion(),
    };
  }

  private normalizeOverrideTime(startTime: string): string {
    const normalized = startTime.trim();
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
    if (!match) {
      throw new Error('startTime must be in HH:mm format');
    }
    return `${match[1]}:${match[2]}`;
  }

  private normalizeMasterVolume(
    value: unknown,
    fieldName:
      | 'mainMasterVolume'
      | 'songMasterVolume'
      | 'instantMasterVolume'
      | 'streamMasterVolume'
      | 'sceneInstantMasterVolume',
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${fieldName} must be a finite number`);
    }
    return Math.max(0, Math.min(1, value));
  }

  private normalizeMixerToggle(
    value: unknown,
    fieldName:
      | 'songMuted'
      | 'instantMuted'
      | 'streamMuted'
      | 'sceneInstantMuted'
      | 'songSolo'
      | 'instantSolo'
      | 'streamSolo'
      | 'sceneInstantSolo',
  ): boolean {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${fieldName} must be a boolean`);
    }
    return value;
  }

  async updateBroadcastSettings(data: {
    enabled?: boolean;
    startTime?: string | null;
    mixerChannels?: unknown;
    mainMasterVolume?: number;
    songMasterVolume?: number;
    instantMasterVolume?: number;
    streamMasterVolume?: number;
    sceneInstantMasterVolume?: number;
    songMuted?: boolean;
    instantMuted?: boolean;
    streamMuted?: boolean;
    sceneInstantMuted?: boolean;
    songSolo?: boolean;
    instantSolo?: boolean;
    streamSolo?: boolean;
    sceneInstantSolo?: boolean;
  }) {
    const currentRaw = await this.ensureBroadcastSettings();
    const current = this.withResolvedBroadcastMixerChannels(currentRaw as any);
    const hasEnabledUpdate = typeof data.enabled === 'boolean';
    const hasStartTimeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'startTime',
    );
    const hasMixerChannelsUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'mixerChannels',
    );
    const hasSongVolumeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'songMasterVolume',
    );
    const hasMainVolumeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'mainMasterVolume',
    );
    const hasInstantVolumeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'instantMasterVolume',
    );
    const hasStreamVolumeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'streamMasterVolume',
    );
    const hasSceneInstantVolumeUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'sceneInstantMasterVolume',
    );
    const hasSongMutedUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'songMuted',
    );
    const hasInstantMutedUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'instantMuted',
    );
    const hasStreamMutedUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'streamMuted',
    );
    const hasSceneInstantMutedUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'sceneInstantMuted',
    );
    const hasSongSoloUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'songSolo',
    );
    const hasInstantSoloUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'instantSolo',
    );
    const hasStreamSoloUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'streamSolo',
    );
    const hasSceneInstantSoloUpdate = Object.prototype.hasOwnProperty.call(
      data,
      'sceneInstantSolo',
    );

    if (
      !hasEnabledUpdate &&
      !hasStartTimeUpdate &&
      !hasMixerChannelsUpdate &&
      !hasMainVolumeUpdate &&
      !hasSongVolumeUpdate &&
      !hasInstantVolumeUpdate &&
      !hasStreamVolumeUpdate &&
      !hasSceneInstantVolumeUpdate &&
      !hasSongMutedUpdate &&
      !hasInstantMutedUpdate &&
      !hasStreamMutedUpdate &&
      !hasSceneInstantMutedUpdate &&
      !hasSongSoloUpdate &&
      !hasInstantSoloUpdate &&
      !hasStreamSoloUpdate &&
      !hasSceneInstantSoloUpdate
    ) {
      return current;
    }

    const enabled = hasEnabledUpdate
      ? Boolean(data.enabled)
      : current.timeOverrideEnabled;
    let startTime: string | null = current.timeOverrideStartTime;
    let startedAt: Date | null = current.timeOverrideStartedAt;

    if (enabled) {
      const hasNonEmptyStartTimeUpdate =
        typeof data.startTime === 'string' && data.startTime.trim().length > 0;
      const sourceStartTime = hasNonEmptyStartTimeUpdate
        ? data.startTime
        : current.timeOverrideStartTime;

      if (!sourceStartTime) {
        throw new BadRequestException(
          'startTime is required when enabling time override',
        );
      }

      const normalizedStartTime = this.normalizeOverrideTime(sourceStartTime);
      const shouldResetStartedAt =
        hasEnabledUpdate && Boolean(data.enabled) === true
          ? true
          : hasNonEmptyStartTimeUpdate &&
            normalizedStartTime !== current.timeOverrideStartTime;

      startTime = normalizedStartTime;
      startedAt = shouldResetStartedAt
        ? new Date()
        : (current.timeOverrideStartedAt ?? new Date());
    } else {
      startTime = null;
      startedAt = null;
    }

    const mainMasterVolume = hasMainVolumeUpdate
      ? this.normalizeMasterVolume(data.mainMasterVolume, 'mainMasterVolume')
      : current.mainMasterVolume;
    let mixerChannels = this.normalizeBroadcastMixerChannels(
      current.mixerChannels,
      this.createDefaultBroadcastMixerChannels(),
    );
    if (hasMixerChannelsUpdate) {
      mixerChannels = this.normalizeBroadcastMixerChannels(
        data.mixerChannels,
        mixerChannels,
      );
    }

    const applyChannelPatch = (
      channelId: 'song' | 'stream' | 'instants' | 'sceneInstant',
      patch: { volume?: number; muted?: boolean; solo?: boolean },
    ) => {
      mixerChannels = mixerChannels.map((channel) => {
        if (channel.id !== channelId) {
          return channel;
        }
        return {
          ...channel,
          ...patch,
        };
      });
    };

    if (hasSongVolumeUpdate) {
      applyChannelPatch('song', {
        volume: this.normalizeMasterVolume(
          data.songMasterVolume,
          'songMasterVolume',
        ),
      });
    }
    if (hasInstantVolumeUpdate) {
      applyChannelPatch('instants', {
        volume: this.normalizeMasterVolume(
          data.instantMasterVolume,
          'instantMasterVolume',
        ),
      });
    }
    if (hasStreamVolumeUpdate) {
      applyChannelPatch('stream', {
        volume: this.normalizeMasterVolume(
          data.streamMasterVolume,
          'streamMasterVolume',
        ),
      });
    }
    if (hasSceneInstantVolumeUpdate) {
      applyChannelPatch('sceneInstant', {
        volume: this.normalizeMasterVolume(
          data.sceneInstantMasterVolume,
          'sceneInstantMasterVolume',
        ),
      });
    }
    if (hasSongMutedUpdate) {
      applyChannelPatch('song', {
        muted: this.normalizeMixerToggle(data.songMuted, 'songMuted'),
      });
    }
    if (hasInstantMutedUpdate) {
      applyChannelPatch('instants', {
        muted: this.normalizeMixerToggle(data.instantMuted, 'instantMuted'),
      });
    }
    if (hasStreamMutedUpdate) {
      applyChannelPatch('stream', {
        muted: this.normalizeMixerToggle(data.streamMuted, 'streamMuted'),
      });
    }
    if (hasSceneInstantMutedUpdate) {
      applyChannelPatch('sceneInstant', {
        muted: this.normalizeMixerToggle(
          data.sceneInstantMuted,
          'sceneInstantMuted',
        ),
      });
    }
    if (hasSongSoloUpdate) {
      applyChannelPatch('song', {
        solo: this.normalizeMixerToggle(data.songSolo, 'songSolo'),
      });
    }
    if (hasInstantSoloUpdate) {
      applyChannelPatch('instants', {
        solo: this.normalizeMixerToggle(data.instantSolo, 'instantSolo'),
      });
    }
    if (hasStreamSoloUpdate) {
      applyChannelPatch('stream', {
        solo: this.normalizeMixerToggle(data.streamSolo, 'streamSolo'),
      });
    }
    if (hasSceneInstantSoloUpdate) {
      applyChannelPatch('sceneInstant', {
        solo: this.normalizeMixerToggle(
          data.sceneInstantSolo,
          'sceneInstantSolo',
        ),
      });
    }

    const song = this.getBroadcastMixerChannel(mixerChannels, 'song');
    const stream = this.getBroadcastMixerChannel(mixerChannels, 'stream');
    const instants = this.getBroadcastMixerChannel(mixerChannels, 'instants');
    const songMasterVolume = song.volume;
    const instantMasterVolume = instants.volume;
    const streamMasterVolume = stream.volume;
    const songMuted = song.muted;
    const instantMuted = instants.muted;
    const streamMuted = stream.muted;
    const songSolo = song.solo;
    const instantSolo = instants.solo;
    const streamSolo = stream.solo;

    const settings = await this.prisma.broadcastSettings.upsert({
      where: { id: ProgramService.BROADCAST_SETTINGS_ID },
      update: {
        timeOverrideEnabled: enabled,
        timeOverrideStartTime: startTime,
        timeOverrideStartedAt: startedAt,
        mixerChannels: mixerChannels as any,
        mainMasterVolume,
        songMasterVolume,
        instantMasterVolume,
        streamMasterVolume,
        songMuted,
        instantMuted,
        streamMuted,
        songSolo,
        instantSolo,
        streamSolo,
      },
      create: {
        id: ProgramService.BROADCAST_SETTINGS_ID,
        timeOverrideEnabled: enabled,
        timeOverrideStartTime: startTime,
        timeOverrideStartedAt: startedAt,
        mixerChannels: mixerChannels as any,
        mainMasterVolume,
        songMasterVolume,
        instantMasterVolume,
        streamMasterVolume,
        songMuted,
        instantMuted,
        streamMuted,
        songSolo,
        instantSolo,
        streamSolo,
      },
    });

    const resolvedSettings = this.withResolvedBroadcastMixerChannels(
      settings as any,
    );

    const broadcastPayload = this.broadcastGlobalUpdate({
      type: 'broadcast_settings_update',
      settings: resolvedSettings,
    });

    return {
      ...resolvedSettings,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getGlobalBroadcastVersion(),
    };
  }

  private getEventSubject(programId: string) {
    const existing = this.eventSubjects.get(programId);
    if (existing) {
      return existing;
    }

    const subject = new Subject<any>();
    this.eventSubjects.set(programId, subject);
    return subject;
  }

  private getTopicVersionMap(topic: ProgramUpdateTopic): Map<string, number> {
    return this.topicVersionByProgramId[topic];
  }

  private getProgramTopicVersion(
    programId: string,
    topic: ProgramUpdateTopic,
  ): number {
    return this.getTopicVersionMap(topic).get(programId) ?? 0;
  }

  private bumpProgramTopicVersion(
    programId: string,
    topic: ProgramUpdateTopic,
  ): number {
    const nextVersion = this.getProgramTopicVersion(programId, topic) + 1;
    this.getTopicVersionMap(topic).set(programId, nextVersion);
    return nextVersion;
  }

  getProgramUpdateVersion(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    topic: ProgramUpdateTopic,
  ): number {
    const normalizedProgramId = this.normalizeProgramId(programId);
    return this.getProgramTopicVersion(normalizedProgramId, topic);
  }

  getGlobalBroadcastVersion(): number {
    return this.globalBroadcastVersion;
  }

  private resolveProgramTopicForEventType(
    eventType: unknown,
  ): ProgramUpdateTopic | null {
    if (typeof eventType !== 'string' || !eventType.trim()) {
      return null;
    }

    switch (eventType) {
      case 'scene_change':
      case 'scene_staged':
      case 'scene_update':
      case 'scene_cleared':
      case 'program_scenes_changed':
      case 'program_media_groups_changed':
        return 'state';
      case 'audio_bus_update':
        return 'audioBus';
      case 'audio_meter_update':
        return 'audioMeter';
      case 'song_playback_update':
      case 'song_off_air':
        return 'songPlayback';
      case 'scene_instant_take':
      case 'scene_instant_stop':
      case 'scene_instant_state':
        return 'sceneInstant';
      default:
        return null;
    }
  }

  private withProgramVersionEnvelope(
    programId: string,
    payload: any,
    options?: {
      bumpVersion?: boolean;
    },
  ): any {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }

    const topic = this.resolveProgramTopicForEventType(payload.type);
    if (!topic) {
      return payload;
    }

    const shouldBumpVersion = options?.bumpVersion ?? true;
    const version = shouldBumpVersion
      ? this.bumpProgramTopicVersion(programId, topic)
      : this.getProgramTopicVersion(programId, topic);

    return {
      ...payload,
      version,
    };
  }

  private withGlobalVersionEnvelope(
    payload: any,
    options?: {
      bumpVersion?: boolean;
    },
  ): any {
    const shouldBumpVersion = options?.bumpVersion ?? true;
    const version = shouldBumpVersion
      ? this.globalBroadcastVersion + 1
      : this.globalBroadcastVersion;
    if (shouldBumpVersion) {
      this.globalBroadcastVersion = version;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        type: 'global_update',
        payload,
        version,
      };
    }

    return {
      ...payload,
      version,
    };
  }

  private normalizeProgramId(programId: string): string {
    const normalized = programId.trim();
    if (!normalized) {
      throw new Error('programId is required');
    }
    return normalized;
  }

  private async getProgramStateRecord(programId: string) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true, programId: true },
    });

    if (!state) {
      throw new Error('Program not found');
    }

    return state;
  }

  private async getProgramStateWithScenes(programId: string) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
        mediaGroups: {
          orderBy: { position: 'asc' },
          include: {
            mediaGroup: {
              include: {
                mediaItems: {
                  include: { media: true },
                  orderBy: { position: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!state) {
      throw new Error('Program not found');
    }

    return this.withStagedSceneState(normalizedProgramId, state);
  }

  private withStagedSceneState<T extends { scenes?: unknown }>(
    programId: string,
    state: T,
  ): T & { stagedSceneId: number | null; stagedScene: any | null } {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const sceneEntries = Array.isArray(state.scenes) ? state.scenes : [];
    const currentStagedSceneId =
      this.stagedSceneByProgramId.get(normalizedProgramId);
    const stagedSceneId =
      typeof currentStagedSceneId === 'number' ? currentStagedSceneId : null;
    const stagedSceneEntry =
      stagedSceneId === null
        ? null
        : sceneEntries.find((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              return false;
            }
            const record = entry as { sceneId?: unknown };
            return record.sceneId === stagedSceneId;
          });

    if (stagedSceneId !== null && !stagedSceneEntry) {
      this.stagedSceneByProgramId.set(normalizedProgramId, null);
      return {
        ...(state as any),
        stagedSceneId: null,
        stagedScene: null,
      };
    }

    return {
      ...(state as any),
      stagedSceneId,
      stagedScene:
        stagedSceneEntry &&
        typeof stagedSceneEntry === 'object' &&
        !Array.isArray(stagedSceneEntry) &&
        'scene' in stagedSceneEntry
          ? ((stagedSceneEntry as { scene?: unknown }).scene ?? null)
          : null,
    };
  }

  async createProgram(programId: string) {
    const normalized = this.normalizeProgramId(programId);

    const existing = await this.prisma.programState.findUnique({
      where: { programId: normalized },
      select: { id: true },
    });

    if (existing) {
      throw new Error('Program already exists');
    }

    await this.prisma.programState.create({
      data: {
        programId: normalized,
        activeSceneId: null,
        audioMixer: this.createDefaultProgramAudioMixerSettings() as any,
      },
    });
    this.stagedSceneByProgramId.set(normalized, null);

    return this.getProgramStateWithScenes(normalized);
  }

  async renameProgram(programId: string, nextProgramId: string) {
    const current = this.normalizeProgramId(programId);
    const next = this.normalizeProgramId(nextProgramId);
    if (current === next) {
      return this.getProgramStateWithScenes(current);
    }

    const existingTarget = await this.prisma.programState.findUnique({
      where: { programId: next },
      select: { id: true },
    });
    if (existingTarget) {
      throw new Error('Target program id already exists');
    }

    const existingSource = await this.prisma.programState.findUnique({
      where: { programId: current },
      select: { id: true },
    });
    if (!existingSource) {
      throw new Error('Program not found');
    }

    await this.prisma.programState.update({
      where: { id: existingSource.id },
      data: { programId: next },
    });

    const currentSubject = this.eventSubjects.get(current);
    if (currentSubject) {
      this.eventSubjects.set(next, currentSubject);
      this.eventSubjects.delete(current);
    }

    const currentAudioMeter = this.programAudioMeterByProgramId.get(current);
    if (currentAudioMeter) {
      this.programAudioMeterByProgramId.set(next, currentAudioMeter);
      this.programAudioMeterByProgramId.delete(current);
    }
    const currentSongPlayback =
      this.programSongPlaybackByProgramId.get(current);
    if (currentSongPlayback) {
      this.programSongPlaybackByProgramId.set(next, currentSongPlayback);
      this.programSongPlaybackByProgramId.delete(current);
    }
    const currentSceneInstantPlayback =
      this.programSceneInstantPlaybackByProgramId.get(current);
    if (currentSceneInstantPlayback) {
      this.programSceneInstantPlaybackByProgramId.set(next, {
        ...currentSceneInstantPlayback,
        programId: next,
      });
      this.programSceneInstantPlaybackByProgramId.delete(current);
    }
    if (this.stagedSceneByProgramId.has(current)) {
      this.stagedSceneByProgramId.set(
        next,
        this.stagedSceneByProgramId.get(current) ?? null,
      );
      this.stagedSceneByProgramId.delete(current);
    }

    return this.getProgramStateWithScenes(next);
  }

  async deleteProgram(programId: string) {
    const normalized = this.normalizeProgramId(programId);
    const existing = await this.prisma.programState.findUnique({
      where: { programId: normalized },
      select: { id: true },
    });

    if (!existing) {
      throw new Error('Program not found');
    }

    await this.prisma.programState.delete({
      where: { id: existing.id },
    });

    const subject = this.eventSubjects.get(normalized);
    if (subject) {
      subject.complete();
      this.eventSubjects.delete(normalized);
    }
    this.programAudioMeterByProgramId.delete(normalized);
    this.programSongPlaybackByProgramId.delete(normalized);
    this.programSceneInstantPlaybackByProgramId.delete(normalized);
    this.stagedSceneByProgramId.delete(normalized);

    return { deletedProgramId: normalized };
  }

  async listPrograms() {
    const states = await this.prisma.programState.findMany({
      orderBy: { programId: 'asc' },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
        mediaGroups: {
          orderBy: { position: 'asc' },
          include: {
            mediaGroup: {
              include: {
                mediaItems: {
                  include: { media: true },
                  orderBy: { position: 'asc' },
                },
              },
            },
          },
        },
      },
    });
    return states.map((state) =>
      this.withStagedSceneState(state.programId, state),
    );
  }

  async getState(programId: string = ProgramService.DEFAULT_PROGRAM_ID) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateWithScenes(normalizedProgramId);
    return {
      ...state,
      version: this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async getStagedScene(programId: string = ProgramService.DEFAULT_PROGRAM_ID) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateWithScenes(normalizedProgramId);
    return {
      programId: state.programId,
      stagedSceneId: state.stagedSceneId ?? null,
      stagedScene: state.stagedScene ?? null,
      version: this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async getProgramAudioBus(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { songSequence: true, audioMixer: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    const mixerSettings = this.withResolvedProgramAudioMixerSettings(
      state.audioMixer,
    );

    return {
      songSequence: state.songSequence ?? null,
      mixerSettings,
      version: this.getProgramTopicVersion(normalizedProgramId, 'audioBus'),
    };
  }

  async updateProgramAudioBus(
    data:
      | { songSequence?: unknown; mixerSettings?: unknown }
      | null
      | undefined,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    if (
      data !== null &&
      data !== undefined &&
      (typeof data !== 'object' || Array.isArray(data))
    ) {
      throw new BadRequestException('audio bus payload must be an object');
    }

    const currentState = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { songSequence: true, audioMixer: true },
    });
    if (!currentState) {
      throw new Error('Program not found');
    }

    const hasSongSequenceUpdate = Boolean(
      data && Object.prototype.hasOwnProperty.call(data, 'songSequence'),
    );
    const hasMixerSettingsUpdate = Boolean(
      data && Object.prototype.hasOwnProperty.call(data, 'mixerSettings'),
    );
    const currentMixerSettings = this.withResolvedProgramAudioMixerSettings(
      currentState.audioMixer,
    );

    if (!hasSongSequenceUpdate && !hasMixerSettingsUpdate) {
      return {
        songSequence: currentState.songSequence ?? null,
        mixerSettings: currentMixerSettings,
        version: this.getProgramTopicVersion(normalizedProgramId, 'audioBus'),
      };
    }

    const nextSongSequence = hasSongSequenceUpdate
      ? ((data as { songSequence?: unknown }).songSequence ?? null)
      : (currentState.songSequence ?? null);
    const nextMixerSettings = hasMixerSettingsUpdate
      ? this.withResolvedProgramAudioMixerSettings(
          (data as { mixerSettings?: unknown }).mixerSettings,
          currentMixerSettings,
        )
      : currentMixerSettings;

    const updatedState = await this.prisma.programState.update({
      where: { programId: normalizedProgramId },
      data: {
        songSequence: nextSongSequence as any,
        audioMixer: nextMixerSettings as any,
      },
      select: { songSequence: true, audioMixer: true },
    });

    const nextSettings = {
      songSequence: updatedState.songSequence ?? null,
      mixerSettings: this.withResolvedProgramAudioMixerSettings(
        updatedState.audioMixer,
        nextMixerSettings,
      ),
    };
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'audio_bus_update',
      programId: normalizedProgramId,
      settings: nextSettings,
      updatedAt: new Date().toISOString(),
    });

    return {
      ...nextSettings,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'audioBus'),
    };
  }

  async getProgramAudioMeter(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    const levels =
      this.programAudioMeterByProgramId.get(normalizedProgramId) ?? {
        song: { vu: 0, peak: 0, peakHold: 0 },
        instants: { vu: 0, peak: 0, peakHold: 0 },
        sceneInstant: { vu: 0, peak: 0, peakHold: 0 },
        main: { vu: 0, peak: 0, peakHold: 0 },
        updatedAt: new Date(0).toISOString(),
      };
    return {
      ...levels,
      version: this.getProgramTopicVersion(normalizedProgramId, 'audioMeter'),
    };
  }

  private normalizeAudioMeterLevel(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${fieldName} must be a finite number`);
    }
    return Math.max(0, Math.min(1, value));
  }

  private normalizeAudioMeterChannel(
    value: unknown,
    fieldName: 'song' | 'instants' | 'sceneInstant' | 'main',
  ): ProgramAudioMeterChannel {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const normalized = Math.max(0, Math.min(1, value));
      return {
        vu: normalized,
        peak: normalized,
        peakHold: normalized,
      };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(
        `${fieldName} must be a number or an object with vu/peak/peakHold`,
      );
    }

    const record = value as Record<string, unknown>;
    const vu = this.normalizeAudioMeterLevel(
      record.vu ?? record.level,
      `${fieldName}.vu`,
    );
    const peak = this.normalizeAudioMeterLevel(
      record.peak ?? vu,
      `${fieldName}.peak`,
    );
    const peakHold = this.normalizeAudioMeterLevel(
      record.peakHold ?? peak,
      `${fieldName}.peakHold`,
    );

    return {
      vu,
      peak: Math.max(peak, vu),
      peakHold: Math.max(peakHold, peak, vu),
    };
  }

  private normalizeSongPlaybackToken(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeSongPlaybackAudioUrl(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeSongPlaybackProgress(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException('progress must be a finite number');
    }
    return Math.max(0, Math.min(1, value));
  }

  private normalizeSongPlaybackCurrentTimeMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException('currentTimeMs must be a finite number');
    }
    return Math.max(0, Math.round(value));
  }

  private normalizeSongPlaybackDurationMs(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        'durationMs must be a positive number or null',
      );
    }
    return Math.round(value);
  }

  private normalizeSongPlaybackPlaying(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new BadRequestException('isPlaying must be a boolean');
    }
    return value;
  }

  async updateProgramAudioMeter(
    data:
      | {
          song?: unknown;
          instants?: unknown;
          sceneInstant?: unknown;
          main?: unknown;
        }
      | null
      | undefined,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    if (!data || typeof data !== 'object') {
      throw new BadRequestException('audio meter payload must be an object');
    }

    const song = this.normalizeAudioMeterChannel(data.song, 'song');
    const instants = this.normalizeAudioMeterChannel(data.instants, 'instants');
    const sceneInstant = this.normalizeAudioMeterChannel(
      data.sceneInstant ?? 0,
      'sceneInstant',
    );
    const main = this.normalizeAudioMeterChannel(data.main, 'main');
    const updatedAt = new Date().toISOString();
    const levels = { song, instants, sceneInstant, main, updatedAt };

    this.programAudioMeterByProgramId.set(normalizedProgramId, levels);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'audio_meter_update',
      programId: normalizedProgramId,
      levels,
    });

    return {
      ...levels,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'audioMeter'),
    };
  }

  async getProgramSongPlayback(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    const playback =
      this.programSongPlaybackByProgramId.get(normalizedProgramId) ?? {
        token: '',
        audioUrl: '',
        progress: 0,
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
        updatedAt: new Date(0).toISOString(),
      };
    return {
      ...playback,
      version: this.getProgramTopicVersion(normalizedProgramId, 'songPlayback'),
    };
  }

  async updateProgramSongPlayback(
    data:
      | {
          token?: string;
          audioUrl?: string;
          progress?: number;
          currentTimeMs?: number;
          durationMs?: number | null;
          isPlaying?: boolean;
        }
      | null
      | undefined,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    if (!data || typeof data !== 'object') {
      throw new BadRequestException('song playback payload must be an object');
    }

    const token = this.normalizeSongPlaybackToken(data.token);
    const audioUrl = this.normalizeSongPlaybackAudioUrl(data.audioUrl);
    const progress = this.normalizeSongPlaybackProgress(data.progress);
    let currentTimeMs = this.normalizeSongPlaybackCurrentTimeMs(
      data.currentTimeMs,
    );
    const durationMs = this.normalizeSongPlaybackDurationMs(data.durationMs);
    const isPlaying = this.normalizeSongPlaybackPlaying(data.isPlaying);

    if (durationMs !== null) {
      currentTimeMs = Math.min(currentTimeMs, durationMs);
    }

    const previousPlayback =
      this.programSongPlaybackByProgramId.get(normalizedProgramId) ?? null;
    if (
      previousPlayback &&
      previousPlayback.token &&
      token &&
      previousPlayback.token === token &&
      previousPlayback.audioUrl === audioUrl &&
      previousPlayback.isPlaying
    ) {
      const backwardDriftMs = previousPlayback.currentTimeMs - currentTimeMs;
      if (
        backwardDriftMs > ProgramService.SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS
      ) {
        return {
          ...previousPlayback,
          version: this.getProgramTopicVersion(
            normalizedProgramId,
            'songPlayback',
          ),
        };
      }
    }

    const playback = {
      token,
      audioUrl,
      progress,
      currentTimeMs,
      durationMs,
      isPlaying,
      updatedAt: new Date().toISOString(),
    };

    this.programSongPlaybackByProgramId.set(normalizedProgramId, playback);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'song_playback_update',
      programId: normalizedProgramId,
      playback,
    });

    return {
      ...playback,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'songPlayback'),
    };
  }

  async getProgramSceneInstantPlayback(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    const playback =
      this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId) ??
      this.createEmptyProgramSceneInstantPlayback(normalizedProgramId);
    return {
      ...playback,
      version: this.getProgramTopicVersion(normalizedProgramId, 'sceneInstant'),
    };
  }

  private parseSceneInstantIdFromSceneMetadata(
    sceneMetadata: unknown,
  ): number | null {
    if (sceneMetadata === null || sceneMetadata === undefined) {
      return null;
    }

    try {
      const parsed =
        typeof sceneMetadata === 'string'
          ? sceneMetadata.trim()
            ? JSON.parse(sceneMetadata)
            : null
          : sceneMetadata;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const sceneInstant =
        'sceneInstant' in parsed
          ? (parsed as Record<string, unknown>).sceneInstant
          : null;
      if (
        !sceneInstant ||
        typeof sceneInstant !== 'object' ||
        Array.isArray(sceneInstant)
      ) {
        return null;
      }
      const instantIdRaw = (sceneInstant as Record<string, unknown>).instantId;
      const instantIdNumeric =
        typeof instantIdRaw === 'number' ? instantIdRaw : Number(instantIdRaw);
      if (
        !Number.isFinite(instantIdNumeric) ||
        instantIdNumeric <= 0 ||
        !Number.isInteger(instantIdNumeric)
      ) {
        return null;
      }
      return instantIdNumeric;
    } catch {
      return null;
    }
  }

  async takeProgramSceneInstant(
    sceneId: number | null | undefined,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    instantIdOverride: number | null | undefined = null,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: {
        activeScene: true,
        scenes: {
          include: {
            scene: true,
          },
        },
      },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    const requestedSceneId =
      typeof sceneId === 'number' && Number.isFinite(sceneId)
        ? Math.round(sceneId)
        : null;
    const targetSceneId =
      requestedSceneId !== null
        ? requestedSceneId
        : (state.activeSceneId ?? null);

    if (targetSceneId === null) {
      throw new BadRequestException('No target scene selected');
    }

    const assignedSceneEntry = state.scenes.find(
      (entry) => entry.sceneId === targetSceneId,
    );
    if (!assignedSceneEntry) {
      throw new BadRequestException('Scene is not assigned to this program');
    }

    const normalizedOverrideInstantId =
      typeof instantIdOverride === 'number' &&
      Number.isFinite(instantIdOverride) &&
      Number.isInteger(instantIdOverride) &&
      instantIdOverride > 0
        ? instantIdOverride
        : null;
    const sceneInstantId =
      normalizedOverrideInstantId ??
      this.parseSceneInstantIdFromSceneMetadata(assignedSceneEntry.scene.metadata);
    if (sceneInstantId === null) {
      throw new BadRequestException(
        'Scene has no configured background instant',
      );
    }

    const instant = await this.prisma.instant.findUnique({
      where: { id: sceneInstantId },
    });
    if (!instant) {
      throw new NotFoundException('Configured scene instant not found');
    }
    if (!instant.enabled) {
      throw new BadRequestException('Configured scene instant is disabled');
    }

    const nowIso = new Date().toISOString();
    const playback: ProgramSceneInstantPlayback = {
      programId: normalizedProgramId,
      sceneId: targetSceneId,
      instantId: instant.id,
      isPlaying: true,
      instant: {
        id: instant.id,
        name: instant.name,
        audioUrl: instant.audioUrl,
        volume: instant.volume,
      },
      startedAt: nowIso,
      updatedAt: nowIso,
    };
    this.programSceneInstantPlaybackByProgramId.set(
      normalizedProgramId,
      playback,
    );

    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_instant_take',
      sceneId: targetSceneId,
      instant: playback.instant,
      loop: true,
      triggeredAt: nowIso,
    });

    return {
      ...playback,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'sceneInstant'),
    };
  }

  async stopProgramSceneInstant(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    fadeMs: number = 0,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);

    const nowIso = new Date().toISOString();
    const previous =
      this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId) ??
      this.createEmptyProgramSceneInstantPlayback(normalizedProgramId);
    const playback: ProgramSceneInstantPlayback = {
      ...previous,
      isPlaying: false,
      startedAt: null,
      updatedAt: nowIso,
    };
    this.programSceneInstantPlaybackByProgramId.set(
      normalizedProgramId,
      playback,
    );

    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_instant_stop',
      sceneId: previous.sceneId ?? null,
      instantId: previous.instantId ?? null,
      triggeredAt: nowIso,
      fadeMs,
    });

    return {
      ...playback,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'sceneInstant'),
    };
  }

  async proxyAudio(
    url: unknown,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (typeof url !== 'string' || !url.trim()) {
      throw new BadRequestException('url is required');
    }

    let normalizedUrl: URL;
    try {
      normalizedUrl = new URL(url.trim());
    } catch {
      throw new BadRequestException('url must be an absolute URL');
    }

    if (
      normalizedUrl.protocol !== 'http:' &&
      normalizedUrl.protocol !== 'https:'
    ) {
      throw new BadRequestException('url must use http or https');
    }

    let response: globalThis.Response;
    try {
      response = await fetch(normalizedUrl.toString());
    } catch {
      throw new BadGatewayException('failed to fetch remote audio');
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `remote audio returned HTTP ${response.status}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const maxBytes = 100 * 1024 * 1024;
    if (arrayBuffer.byteLength > maxBytes) {
      throw new BadRequestException('audio file is too large to proxy');
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async addSceneToProgram(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const scene = await this.prisma.scene.findUnique({
      where: { id: sceneId },
    });
    if (!scene) {
      throw new Error('Scene not found');
    }

    const state = await this.getProgramStateRecord(programId);

    const existing = await this.prisma.programScene.findUnique({
      where: {
        programStateId_sceneId: {
          programStateId: state.id,
          sceneId,
        },
      },
    });

    if (!existing) {
      const currentMaxPosition = await this.prisma.programScene.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });
      const nextPosition = (currentMaxPosition._max.position ?? -1) + 1;

      await this.prisma.programScene.create({
        data: {
          programStateId: state.id,
          sceneId,
          position: nextPosition,
        },
      });
    }

    const normalizedProgramId = this.normalizeProgramId(programId);
    const updated = await this.getProgramStateWithScenes(normalizedProgramId);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'program_scenes_changed',
      programId: normalizedProgramId,
      state: updated,
    });
    return {
      ...updated,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async removeSceneFromProgram(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true, activeSceneId: true },
    });

    if (!state) {
      throw new Error('Program not found');
    }

    await this.prisma.programScene.deleteMany({
      where: {
        programStateId: state.id,
        sceneId,
      },
    });

    if (
      (this.stagedSceneByProgramId.get(normalizedProgramId) ?? null) === sceneId
    ) {
      this.stagedSceneByProgramId.set(normalizedProgramId, null);
    }

    const sceneInstantPlayback =
      this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId);
    if (
      sceneInstantPlayback?.isPlaying &&
      sceneInstantPlayback.sceneId === sceneId
    ) {
      await this.stopProgramSceneInstant(normalizedProgramId);
    }

    if (state.activeSceneId === sceneId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeSceneId: null },
      });
    }

    const updated = await this.getProgramStateWithScenes(normalizedProgramId);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'program_scenes_changed',
      programId: normalizedProgramId,
      state: updated,
    });
    return {
      ...updated,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async listProgramMediaGroups(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: {
        mediaGroups: {
          orderBy: { position: 'asc' },
          include: {
            mediaGroup: {
              include: {
                mediaItems: {
                  include: { media: true },
                  orderBy: { position: 'asc' },
                },
              },
            },
          },
        },
      },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    return state.mediaGroups.map((entry) => {
      const group = entry.mediaGroup;
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        items: group.mediaItems.map((item) => ({
          id: item.id,
          mediaGroupId: item.mediaGroupId,
          mediaId: item.mediaId,
          position: item.position,
          media: {
            id: item.media.id,
            name: item.media.name,
            imageUrl: item.media.imageUrl,
            createdAt: item.media.createdAt,
            updatedAt: item.media.updatedAt,
          },
        })),
      };
    });
  }

  async addMediaGroupToProgram(
    mediaGroupId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const mediaGroup = await this.prisma.mediaGroup.findUnique({
      where: { id: mediaGroupId },
      select: { id: true },
    });
    if (!mediaGroup) {
      throw new Error('Media group not found');
    }

    const state = await this.getProgramStateRecord(programId);
    const existing = await this.prisma.programMediaGroup.findUnique({
      where: {
        programStateId_mediaGroupId: {
          programStateId: state.id,
          mediaGroupId,
        },
      },
    });

    if (!existing) {
      const currentMaxPosition = await this.prisma.programMediaGroup.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });
      const nextPosition = (currentMaxPosition._max.position ?? -1) + 1;

      await this.prisma.programMediaGroup.create({
        data: {
          programStateId: state.id,
          mediaGroupId,
          position: nextPosition,
        },
      });
    }

    const normalizedProgramId = this.normalizeProgramId(programId);
    const updated = await this.getProgramStateWithScenes(normalizedProgramId);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'program_media_groups_changed',
      programId: normalizedProgramId,
      state: updated,
    });
    return {
      ...updated,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async removeMediaGroupFromProgram(
    mediaGroupId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    await this.prisma.programMediaGroup.deleteMany({
      where: {
        programStateId: state.id,
        mediaGroupId,
      },
    });

    const updated = await this.getProgramStateWithScenes(normalizedProgramId);
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'program_media_groups_changed',
      programId: normalizedProgramId,
      state: updated,
    });
    return {
      ...updated,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async stageScene(
    sceneId: number | null,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: {
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    let nextStagedSceneId: number | null = null;
    let stagedScene: unknown = null;

    if (typeof sceneId === 'number' && Number.isFinite(sceneId)) {
      const assignedSceneEntry = state.scenes.find(
        (programScene) => programScene.sceneId === sceneId,
      );
      if (!assignedSceneEntry) {
        throw new BadRequestException('Scene is not assigned to this program');
      }
      nextStagedSceneId = sceneId;
      stagedScene = assignedSceneEntry.scene;
    }

    this.stagedSceneByProgramId.set(normalizedProgramId, nextStagedSceneId);

    const payload = {
      type: 'scene_staged',
      programId: normalizedProgramId,
      stagedSceneId: nextStagedSceneId,
      scene: stagedScene,
      updatedAt: new Date().toISOString(),
    };
    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, payload);

    return {
      programId: normalizedProgramId,
      stagedSceneId: nextStagedSceneId,
      stagedScene: stagedScene ?? null,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async activateScene(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    transitionId?: string | null,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: { scenes: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    const isAssigned = state.scenes.some(
      (programScene) => programScene.sceneId === sceneId,
    );
    if (!isAssigned) {
      throw new Error('Scene is not assigned to this program');
    }

    const updatedState = await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeSceneId: sceneId },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });

    const normalizedTransitionId =
      typeof transitionId === 'string' && transitionId.trim()
        ? transitionId.trim()
        : null;
    this.stagedSceneByProgramId.set(normalizedProgramId, sceneId);

    const sceneInstantId = updatedState.activeScene?.metadata
      ? this.parseSceneInstantIdFromSceneMetadata(
          updatedState.activeScene.metadata,
        )
      : null;
    const currentSceneInstantPlayback =
      this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId);
    const shouldFadeOutPreviousSceneInstant =
      currentSceneInstantPlayback?.isPlaying &&
      currentSceneInstantPlayback.sceneId !== sceneId;

    if (sceneInstantId !== null) {
      try {
        if (shouldFadeOutPreviousSceneInstant) {
          await this.stopProgramSceneInstant(normalizedProgramId, 1500);
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 1500);
          });
        }
        await this.takeProgramSceneInstant(sceneId, normalizedProgramId);
      } catch (err) {
        console.warn(
          `Could not play background instant for scene ${sceneId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      const sceneInstantPlayback =
        this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId);
      if (
        sceneInstantPlayback?.isPlaying &&
        sceneInstantPlayback.sceneId !== sceneId
      ) {
        await this.stopProgramSceneInstant(normalizedProgramId, 1500);
      }
    }

    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_change',
      transitionId: normalizedTransitionId,
      state: updatedState,
    });

    return {
      ...updatedState,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async takeProgramOffAir(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: { scenes: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    if (!state.activeSceneId) {
      const currentState = await this.getProgramStateWithScenes(
        normalizedProgramId,
      );
      return {
        ...currentState,
        version: this.getProgramTopicVersion(normalizedProgramId, 'state'),
      };
    }

    const updatedState = await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeSceneId: null },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });

    const sceneInstantPlayback =
      this.programSceneInstantPlaybackByProgramId.get(normalizedProgramId);
    if (sceneInstantPlayback?.isPlaying) {
      await this.stopProgramSceneInstant(normalizedProgramId, 1500);
    }

    const broadcastPayload = this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_change',
      transitionId: null,
      state: updatedState,
    });

    return {
      ...updatedState,
      version:
        broadcastPayload && typeof broadcastPayload.version === 'number'
          ? broadcastPayload.version
          : this.getProgramTopicVersion(normalizedProgramId, 'state'),
    };
  }

  async takeProgramSongOffAir(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const updatedAt = new Date().toISOString();

    const currentState = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { songSequence: true, audioMixer: true },
    });
    if (!currentState) {
      throw new Error('Program not found');
    }
    const currentMixerSettings = this.withResolvedProgramAudioMixerSettings(
      currentState.audioMixer,
    );

    if (
      currentState.songSequence &&
      typeof currentState.songSequence === 'object' &&
      !Array.isArray(currentState.songSequence)
    ) {
      const updatedSequence = {
        ...(currentState.songSequence as Record<string, unknown>),
        activeItemId: null,
      };
      await this.prisma.programState.update({
        where: { programId: normalizedProgramId },
        data: {
          songSequence: updatedSequence as any,
        },
      });
      this.broadcastUpdate(normalizedProgramId, {
        type: 'audio_bus_update',
        programId: normalizedProgramId,
        settings: {
          songSequence: updatedSequence,
          mixerSettings: currentMixerSettings,
        },
        updatedAt,
      });
    }

    const stoppedPlayback = {
      token: '',
      audioUrl: '',
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      updatedAt,
    };
    this.programSongPlaybackByProgramId.set(
      normalizedProgramId,
      stoppedPlayback,
    );

    this.broadcastUpdate(normalizedProgramId, {
      type: 'song_off_air',
      programId: normalizedProgramId,
      triggeredAt: updatedAt,
    });

    this.broadcastUpdate(normalizedProgramId, {
      type: 'song_playback_update',
      programId: normalizedProgramId,
      playback: stoppedPlayback,
    });

    return { ok: true, programId: normalizedProgramId };
  }

  async requestProgramReload(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    await this.getProgramStateRecord(normalizedProgramId);
    const triggeredAt = new Date().toISOString();

    this.broadcastUpdate(normalizedProgramId, {
      type: 'program_reload',
      programId: normalizedProgramId,
      triggeredAt,
    });

    return {
      ok: true,
      programId: normalizedProgramId,
      triggeredAt,
    };
  }

  async getProgramIdsByActiveScene(sceneId: number) {
    const states = await this.prisma.programState.findMany({
      where: { activeSceneId: sceneId },
      select: { programId: true },
    });
    return states.map((state) => state.programId);
  }

  async clearActiveScene(sceneId: number) {
    const programIds = await this.getProgramIdsByActiveScene(sceneId);
    if (programIds.length === 0) {
      return [];
    }

    await this.prisma.programState.updateMany({
      where: { activeSceneId: sceneId },
      data: { activeSceneId: null },
    });

    for (const programId of programIds) {
      const sceneInstantPlayback =
        this.programSceneInstantPlaybackByProgramId.get(programId);
      if (
        sceneInstantPlayback?.isPlaying &&
        sceneInstantPlayback.sceneId === sceneId
      ) {
        await this.stopProgramSceneInstant(programId, 1500);
      }
    }

    return programIds;
  }

  async getProgramIdsByAssignedScene(sceneId: number) {
    const rows = await this.prisma.programScene.findMany({
      where: { sceneId },
      include: {
        programState: {
          select: { programId: true },
        },
      },
    });

    return [...new Set(rows.map((row) => row.programState.programId))];
  }

  async listInstants() {
    return this.prisma.instant.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  async createInstant(data: {
    name: string;
    audioUrl: string;
    volume?: number;
    enabled?: boolean;
  }) {
    const name = (data.name || '').trim();
    const audioUrl = (data.audioUrl || '').trim();

    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!audioUrl) {
      throw new BadRequestException('audioUrl is required');
    }

    const maxPosition = await this.prisma.instant.aggregate({
      _max: { position: true },
    });
    const nextPosition = (maxPosition._max.position ?? -1) + 1;

    return this.prisma.instant.create({
      data: {
        name,
        audioUrl,
        volume:
          typeof data.volume === 'number' && Number.isFinite(data.volume)
            ? Math.min(1, Math.max(0, data.volume))
            : 1,
        enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
        position: nextPosition,
      },
    });
  }

  async updateInstant(
    instantId: number,
    data: {
      name?: string;
      audioUrl?: string;
      volume?: number;
      enabled?: boolean;
    },
  ) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
      select: { id: true },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) {
        throw new BadRequestException('name cannot be empty');
      }
      updateData.name = name;
    }

    if (data.audioUrl !== undefined) {
      const audioUrl = data.audioUrl.trim();
      if (!audioUrl) {
        throw new BadRequestException('audioUrl cannot be empty');
      }
      updateData.audioUrl = audioUrl;
    }

    if (data.volume !== undefined) {
      if (!Number.isFinite(data.volume)) {
        throw new BadRequestException('volume must be a number');
      }
      updateData.volume = Math.min(1, Math.max(0, data.volume));
    }

    if (data.enabled !== undefined) {
      updateData.enabled = Boolean(data.enabled);
    }

    return this.prisma.instant.update({
      where: { id: instant.id },
      data: updateData,
    });
  }

  async deleteInstant(instantId: number) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
      select: { id: true },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }

    await this.prisma.instant.delete({
      where: { id: instant.id },
    });

    const remaining = await this.prisma.instant.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    await Promise.all(
      remaining.map((item, index) =>
        this.prisma.instant.update({
          where: { id: item.id },
          data: { position: index },
        }),
      ),
    );

    return { deletedInstantId: instant.id };
  }

  async playInstant(
    instantId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }
    if (!instant.enabled) {
      throw new BadRequestException('Instant is disabled');
    }

    const normalizedProgramId = this.normalizeProgramId(programId);

    this.broadcastUpdate(normalizedProgramId, {
      type: 'instant_play',
      instant: {
        id: instant.id,
        name: instant.name,
        audioUrl: instant.audioUrl,
        volume: instant.volume,
      },
      triggeredAt: new Date().toISOString(),
    });

    return { ok: true };
  }

  async stopAllInstants(programId: string = ProgramService.DEFAULT_PROGRAM_ID) {
    const normalizedProgramId = this.normalizeProgramId(programId);

    this.broadcastUpdate(normalizedProgramId, {
      type: 'instant_stop_all',
      triggeredAt: new Date().toISOString(),
    });

    return { ok: true };
  }

  broadcastUpdate(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    data: any,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const payload = this.withProgramVersionEnvelope(
      normalizedProgramId,
      data,
      {
        bumpVersion: true,
      },
    );

    this.getEventSubject(normalizedProgramId).next(payload);
    this.notifyEventListeners({
      scope: 'program',
      programId: normalizedProgramId,
      data: payload,
    });
    return payload;
  }

  private broadcastGlobalUpdate(data: any) {
    const payload = this.withGlobalVersionEnvelope(data, { bumpVersion: true });
    for (const subject of this.eventSubjects.values()) {
      subject.next(payload);
    }
    this.notifyEventListeners({
      scope: 'global',
      programId: null,
      data: payload,
    });
    return payload;
  }

  addEventListener(
    listener: (event: {
      scope: 'program' | 'global';
      programId: string | null;
      data: any;
    }) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private notifyEventListeners(event: {
    scope: 'program' | 'global';
    programId: string | null;
    data: any;
  }): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  getEventStream(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ): Observable<{ data: string }> {
    return this.getEventSubject(programId)
      .asObservable()
      .pipe(
        map((data) => ({
          data: JSON.stringify(data),
        })),
      );
  }
}
