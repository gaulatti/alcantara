import type { ComponentProps } from "react";
import { vi } from "vitest";
import type { RadioPanel } from "./RadioPanel";

// A minimal running timed block for the radio desk: a rundown that started at its scheduled time, a playing song and
// one cartwall instant. Shared by RadioPanel tests so each test changes only what it is about. Fictional names only.
export type RadioPanelProps = ComponentProps<typeof RadioPanel>;

export function radioPanelProps(overrides: Partial<RadioPanelProps> = {}): RadioPanelProps {
  const now = new Date().toISOString();
  return {
    programId: "radio-demo",
    fixtureData: {
      monitorAudioUrl: "https://example.test/monitor.mp3",
      stream: { running: true, uptime: 60_000 },
      palazzo: {
        programId: "radio-demo",
        programType: "radio",
        palazzoUrl: "http://example.test",
        instanceId: "fixture",
        connection: "connected",
        lastEventAt: now,
        lastSnapshotAt: now,
        degraded: false,
        detail: null,
      },
      output: {
        state: "audible",
        expectedAudio: true,
        outputRms: 0.08,
        lastSampleAt: now,
        quietForMs: null,
      },
      recovery: { preparedVersion: null, automation: null, connection: "connected" },
      logs: [
        {
          id: 1,
          name: "Morning hour",
          scheduledAt: now,
          publishedAt: now,
          lastStartedAt: now,
          revision: 1,
          loop: false,
          isRunning: true,
          activeItemId: "cue-1",
          items: Array.from({ length: 6 }, (_, i) => ({
            id: `cue-${i + 1}`,
            kind: "playSong" as const,
            songId: i + 1,
            ...(i === 0 ? { clockOffsetSeconds: 0 } : {}),
          })),
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    songSequence: {
      mode: "manual",
      loop: false,
      activeItemId: "song-1",
      startedAt: 0,
      items: [
        {
          id: "song-1",
          kind: "preset",
          title: "City lights",
          artist: "Test signals",
          audioUrl: "https://example.test/one.mp3",
          coverUrl: "",
          durationMs: 180_000,
        },
      ],
    },
    songQueue: [],
    songCatalog: [],
    programSongPlayback: {
      isPlaying: true,
      title: "City lights",
      artist: "Test signals",
      audioUrl: "https://example.test/one.mp3",
      token: "song-1:playback",
      durationMs: 180_000,
      currentTimeMs: 42_000,
      progress: 42_000 / 180_000,
      updatedAt: now,
      telemetryStale: false,
    },
    instants: [
      { id: 1, name: "News opener", audioUrl: "https://example.test/news.mp3", volume: 1, enabled: true, position: 0 },
      { id: 2, name: "Disabled sting", audioUrl: "https://example.test/sting.mp3", volume: 1, enabled: false, position: 1 },
    ],
    instantSearch: "",
    instantPlayback: {},
    mixer: {
      song: { volume: 0.7, peak: 0.4 },
      instants: { volume: 0.8, peak: 0 },
      main: { volume: 0.9, peak: 0.5 },
      saving: false,
      error: null,
    },
    onSaveSongSequence: vi.fn(),
    onQueueSong: vi.fn(),
    onRemoveQueuedSong: vi.fn(),
    onReorderSongQueue: vi.fn(),
    onTakeOffAir: vi.fn(async () => {}),
    onInstantSearchChange: vi.fn(),
    onTriggerInstant: vi.fn(),
    onStopAllInstants: vi.fn(),
    onSongVolumeChange: vi.fn(),
    onInstantVolumeChange: vi.fn(),
    onMainVolumeChange: vi.fn(),
    onToggleSongMuted: vi.fn(),
    onToggleInstantMuted: vi.fn(),
    ...overrides,
  } as RadioPanelProps;
}
