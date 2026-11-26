import type { ProgramSongPlaybackState } from "../../models/broadcast";
import type { StatePillTone } from "./primitives";

// What the on-air strip says (gaulatti/alcantara#298). Everything comes from the program's
// ProgramSongPlaybackState and the status the desk already polls; a state the desk cannot know is
// shown as unverified or unavailable, never as a good one.

/**
 * "unconfirmed": the desk has a song playing, but the engine is not connected to confirm it (#609).
 * "unverified": the engine is connected, but no fresh output level arrived for a few seconds (#706).
 */
export type OnAirState =
  | "on-air"
  | "off-air"
  | "delayed"
  | "unconfirmed"
  | "unverified";

export interface OnAirChip {
  id: "stream" | "engine" | "monitor";
  tone: StatePillTone;
  label: string;
  title?: string;
}

export interface NextUp {
  title: string;
  artist: string;
  durationMs: number | null;
}

export interface OnAirView {
  state: OnAirState;
  /**
   * "On air" only when the engine is connected and its report is fresh; "Not confirmed" while the
   * engine is not connected, "Status delayed" when the report is stale, otherwise "Off air".
   */
  label: string;
  title: string | null;
  artist: string | null;
  /** Null when there is no length, or when a stale report would show a frozen clock. */
  elapsedMs: number | null;
  remainingMs: number | null;
  intro: { label: string; tone: StatePillTone } | null;
  next: { title: string; detail: string } | null;
  modeLabel: string;
  chips: OnAirChip[];
}

export interface OnAirInput {
  playback: ProgramSongPlaybackState | null;
  /** No fresh output level sample for OUTPUT_SAMPLE_UNVERIFIED_MS (#706): display only. */
  outputUnverified?: boolean;
  next: NextUp | null;
  mode: "manual" | "autoplay" | "shuffle";
  /** null when the stream status is unknown. */
  streamRunning: boolean | null;
  engine: {
    connected: boolean;
    degraded: boolean;
    unavailableLabel: string;
    /** What the backend says about the engine; shown as the chip's tooltip. */
    detail?: string | null;
  };
  monitor: "stopped" | "buffering" | "playing" | "unavailable";
}

const MODE_LABELS = {
  manual: "Manual",
  autoplay: "Autoplay",
  shuffle: "Shuffle",
} as const;

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—:—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function introOf(playback: ProgramSongPlaybackState) {
  switch (playback.introStatus) {
    case "pending":
      return { label: "Intro queued", tone: "info" as const };
    case "playing":
      return { label: "Intro playing", tone: "info" as const };
    case "completed":
      return { label: "Intro played", tone: "idle" as const };
    case "degraded":
      return {
        label: `Intro unavailable${playback.introFailureReason ? `: ${playback.introFailureReason}` : ""}`,
        tone: "warn" as const,
      };
    default:
      return null;
  }
}

export function deriveOnAir(input: OnAirInput): OnAirView {
  const { playback } = input;
  const live = playback?.isPlaying === true;
  // Only the engine confirms that a song is on air (gaulatti/alcantara#609).
  const unconfirmed = live && !input.engine.connected;
  const stale = live && !unconfirmed && playback?.telemetryStale === true;
  const unverified =
    live && !unconfirmed && !stale && input.outputUnverified === true;
  const hasLength =
    live &&
    typeof playback?.durationMs === "number" &&
    playback.durationMs > 0;
  const elapsed =
    live && !stale && !unconfirmed ? Math.max(0, playback!.currentTimeMs) : null;
  const clampedElapsed =
    elapsed !== null && hasLength
      ? Math.min(elapsed, playback!.durationMs as number)
      : elapsed;

  const chips: OnAirChip[] = [
    input.streamRunning === null
      ? { id: "stream", tone: "warn", label: "Stream unverified" }
      : input.streamRunning
        ? { id: "stream", tone: "ok", label: "Stream verified" }
        : { id: "stream", tone: "bad", label: "Stream offline" },
    input.engine.connected
      ? input.engine.degraded
        ? {
            id: "engine",
            tone: "warn",
            label: "Engine degraded",
            title: input.engine.detail ?? undefined,
          }
        : {
            id: "engine",
            tone: "ok",
            label: "Engine ready",
            title: input.engine.detail ?? undefined,
          }
      : {
          id: "engine",
          tone: "warn",
          label: input.engine.unavailableLabel,
          title: input.engine.detail ?? undefined,
        },
    input.monitor === "playing"
      ? { id: "monitor", tone: "info", label: "Listening" }
      : input.monitor === "buffering"
        ? { id: "monitor", tone: "info", label: "Monitor starting" }
        : input.monitor === "unavailable"
          ? { id: "monitor", tone: "idle", label: "Monitor unavailable" }
          : { id: "monitor", tone: "idle", label: "Monitor off" },
  ];

  return {
    state: !live
      ? "off-air"
      : unconfirmed
        ? "unconfirmed"
        : stale
          ? "delayed"
          : unverified
            ? "unverified"
            : "on-air",
    label: !live
      ? "Off air"
      : unconfirmed
        ? "Not confirmed"
        : stale
          ? "Status delayed"
          : unverified
            ? "Unverified"
            : "On air",
    title: live ? (playback!.title || "Title unavailable") : null,
    artist: live ? (playback!.artist || "Artist unavailable") : null,
    elapsedMs: clampedElapsed,
    remainingMs:
      clampedElapsed !== null && hasLength
        ? (playback!.durationMs as number) - clampedElapsed
        : null,
    intro: live ? introOf(playback!) : null,
    next: input.next
      ? {
          title: input.next.title,
          detail: [
            input.next.artist,
            input.next.durationMs ? formatClock(input.next.durationMs) : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : null,
    modeLabel: MODE_LABELS[input.mode],
    chips,
  };
}
