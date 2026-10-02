import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { SongEngineEvent } from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';

export type OutputConfidenceState =
  | 'unknown'
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'audible'
  | 'silent';

interface Observation {
  expectedAudio: boolean;
  available: boolean;
  lastSampleAt: number | null;
  lastRms: number | null;
  quietSince: number | null;
  lastReportedState: OutputConfidenceState;
}

const AUDIO_THRESHOLD = 0.001;
const SILENCE_LIMIT_MS = 10_000;
const SAMPLE_STALE_MS = 15_000;

@Injectable()
export class RadioOutputConfidenceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly observations = new Map<string, Observation>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly metrics: RadioMetricsService) {}

  onModuleInit(): void {
    this.refreshTimer = setInterval(() => {
      const now = Date.now();
      for (const observation of this.observations.values())
        this.recordTransition(observation, this.state(observation, now));
    }, 5000);
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  observe(event: SongEngineEvent): void {
    const observation = this.ensure(event.programId);
    if (
      event.type === 'song_playback_active' ||
      event.type === 'playback_update'
    ) {
      observation.expectedAudio = event.playback.isPlaying;
      if (!observation.expectedAudio) observation.quietSince = null;
    } else if (event.type === 'song_off_air') {
      observation.expectedAudio = false;
      observation.quietSince = null;
    } else if (event.type === 'radio_leg_status') {
      observation.available =
        event.status.connection === 'connected' ||
        event.status.connection === 'polling';
      if (!observation.available) observation.quietSince = null;
    } else if (event.type === 'audio_levels') {
      const sampledAt = Date.parse(event.sampledAt);
      if (
        !Number.isFinite(sampledAt) ||
        sampledAt <= (observation.lastSampleAt ?? 0)
      )
        return;
      observation.lastSampleAt = sampledAt;
      observation.lastRms = event.levels.output.rms;
      if (observation.expectedAudio && observation.lastRms < AUDIO_THRESHOLD) {
        observation.quietSince ??= sampledAt;
      } else {
        observation.quietSince = null;
      }
    }
    this.recordTransition(observation, this.state(observation, Date.now()));
  }

  get(programId: string, now = Date.now()) {
    const observation = this.observations.get(programId);
    if (!observation)
      return {
        state: 'unknown' as const,
        expectedAudio: false,
        outputRms: null,
        lastSampleAt: null,
        quietForMs: null,
      };
    const state = this.state(observation, now);
    this.recordTransition(observation, state);
    return {
      state,
      expectedAudio: observation.expectedAudio,
      outputRms: observation.lastRms,
      lastSampleAt:
        observation.lastSampleAt === null
          ? null
          : new Date(observation.lastSampleAt).toISOString(),
      quietForMs:
        observation.quietSince === null
          ? null
          : Math.max(0, now - observation.quietSince),
    };
  }

  private ensure(programId: string): Observation {
    let observation = this.observations.get(programId);
    if (!observation) {
      observation = {
        expectedAudio: false,
        available: false,
        lastSampleAt: null,
        lastRms: null,
        quietSince: null,
        lastReportedState: 'unknown',
      };
      this.observations.set(programId, observation);
    }
    return observation;
  }

  private state(observation: Observation, now: number): OutputConfidenceState {
    if (!observation.available) return 'unavailable';
    if (
      observation.lastSampleAt === null ||
      now - observation.lastSampleAt > SAMPLE_STALE_MS
    )
      return 'unknown';
    if (observation.lastRms !== null && observation.lastRms >= AUDIO_THRESHOLD)
      return 'audible';
    if (!observation.expectedAudio) return 'idle';
    if (
      observation.quietSince !== null &&
      now - observation.quietSince >= SILENCE_LIMIT_MS
    )
      return 'silent';
    return 'checking';
  }

  private recordTransition(
    observation: Observation,
    state: OutputConfidenceState,
  ): void {
    if (state === observation.lastReportedState) return;
    this.metrics.recordOutputConfidenceTransition(state);
    observation.lastReportedState = state;
    this.metrics.recordOutputSilentPrograms(
      [...this.observations.values()].filter(
        (item) => item.lastReportedState === 'silent',
      ).length,
    );
  }
}
