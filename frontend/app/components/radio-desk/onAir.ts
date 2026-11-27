import type { ProgramSongPlaybackState } from "../../models/broadcast";
import type { StatePillTone } from "./primitives";

// What the on-air strip says (gaulatti/alcantara#298). Everything comes from the program's
// ProgramSongPlaybackState and the status the desk already polls; a state the desk cannot know is
// shown as unverified or unavailable, never as a good one.

/**
 * "unconfirmed": the desk has a song playing, but the engine is not connected to confirm it (#609), or
 *   Palazzo answers but its playout (Liquidsoap) is down, so nothing can air (the airing walk's W5).
 * "unverified": the engine is connected, but no fresh output level arrived for a few seconds (#706).
 * With no song commanded and the output freshly audible, the strip never says Off air (D7). Palazzo airs its local
 * filler playlist by itself after FILLER_HOLDOFF_SECONDS (15 s) with no song, intro, instant or live input
 * (gaulatti/palazzo src/stream/liquidsoap-script.ts, `filler_on_air`), and its snapshot names no track for it, so:
 * "fallback": the engine is connected, its playout is up, and the desk knows no other source is on the air.
 * "off-rundown": the engine is connected and its playout is up, but another source is on the air, or the desk cannot
 *   tell: "Audio on air · not from the rundown".
 * "rotation-ended": nothing on air and a rotation that does not loop ran out; the engine left it manual (walk part 4).
 * "audio-unconfirmed": the same generic label while the engine is not connected or its playout is down, never in
 *   the live tone.
 */
export type OnAirState =
  | "on-air"
  | "fallback"
  | "off-rundown"
  | "audio-unconfirmed"
  | "rotation-ended"
  | "off-air"
  | "delayed"
  | "unconfirmed"
  | "unverified";

export interface OnAirChip {
  id: "output" | "stream" | "engine" | "monitor" | "guests";
  tone: StatePillTone;
  label: string;
  title?: string;
  /** Where to fix what the chip reports. */
  href?: string;
}

export interface NextUp {
  title: string;
  artist: string;
  durationMs: number | null;
  /** A looping rotation of one song: next is the song on air again. */
  sameSong?: boolean;
  /** Where the next song comes from: the Play Next queue, or the rotation. */
  via?: "queue" | "rotation";
}

export interface OnAirView {
  state: OnAirState;
  /**
   * "On air" only when the engine is connected and its report is fresh; "Not confirmed" while the
   * engine is not connected, "Status delayed" when the report is stale, otherwise "Off air".
   */
  label: string;
  /** A jingle is on in front of the next song: the title names the jingle and there is no song clock. */
  jingle?: boolean;
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
    /** No engine status has answered yet: its state is unknown, never shown as unavailable. */
    unknown?: boolean;
    degraded: boolean;
    unavailableLabel: string;
    /** What the backend says about the engine; shown as the chip's tooltip. */
    detail?: string | null;
  };
  monitor: "stopped" | "buffering" | "playing" | "unavailable";
  /** Output confidence reads silent: a song is expected to play, but the output is quiet (#694). */
  outputSilent?: boolean;
  /** Palazzo answers but its playout (Liquidsoap) is down: nothing can air. */
  playoutDown?: boolean;
  /** Output confidence reads audible: the station is airing something (D7). */
  outputAudible?: boolean;
  /**
   * Whether the desk knows of another source on the air besides a commanded song (D7): an instant, scene audio, live
   * input or a log event. "none" only when it knows there is none; absent reads as "unknown".
   */
  otherAudio?: "none" | "active" | "unknown";
  /** The rotation ran out and was left manual (its endedAt): nothing is scheduled (walk part 4). */
  rotationEnded?: boolean;
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
  // Only the engine confirms that a song is on air (gaulatti/alcantara#609), and never while its playout is
  // down: a fresh output sample or a running rundown must not turn the pill back to On air (W5).
  const unconfirmed =
    live && (!input.engine.connected || input.playoutDown === true);
  const stale = live && !unconfirmed && playback?.telemetryStale === true;
  const unverified =
    live && !unconfirmed && !stale && input.outputUnverified === true;
  // A commanded jingle has no song under it: the engine says what is on without saying a song plays.
  const commandedJingle =
    !live && Boolean(playback?.jingle) && input.engine.connected && input.playoutDown !== true;
  const jingling = commandedJingle || (live && !unconfirmed && Boolean(playback?.jingle));
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
    // Dead air leads the chips, so the strip never reads as all good while the output is silent
    // (gaulatti/alcantara#694).
    ...(input.outputSilent
      ? [
          {
            id: "output" as const,
            tone: "bad" as const,
            label: "Dead air",
            title:
              "Expected audio is silent: a song is playing but the output is quiet.",
          },
        ]
      : []),
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
      : input.engine.unknown
        ? {
            id: "engine",
            tone: "idle",
            label: "Checking engine",
            title: "Waiting for the engine's first status.",
          }
        : {
            id: "engine",
            tone: "warn",
            label: input.engine.unavailableLabel,
            title: input.engine.detail ?? undefined,
            ...(/not configured|disabled in settings/.test(input.engine.unavailableLabel)
              ? { href: "/radio-settings" }
              : {}),
          },
    input.monitor === "playing"
      ? { id: "monitor", tone: "info", label: "Listening" }
      : input.monitor === "buffering"
        ? { id: "monitor", tone: "info", label: "Monitor starting" }
        : input.monitor === "unavailable"
          ? { id: "monitor", tone: "idle", label: "Monitor unavailable" }
          : { id: "monitor", tone: "idle", label: "Monitor off" },
  ];
  // Palazzo answers but its playout (Liquidsoap) is down: the engine is not ready, whatever its connection says.
  // A Palazzo that is not connected keeps its own unavailable state.
  const engineChips =
    input.engine.connected && input.playoutDown
      ? chips.map((chip) =>
          chip.id === "engine"
            ? {
                id: "engine" as const,
                tone: "bad" as const,
                label: "Playout down",
                title:
                  "Palazzo answers, but its playout engine (Liquidsoap) is down: nothing can air.",
              }
            : chip,
        )
      : chips;
  // While Dead air shows, the good chips stay truthful but neutral, so the red Dead air chip is the
  // only coloured "all is well / not well" signal on the strip (gaulatti/alcantara#694 closing walk).
  // Warnings keep their colour: they are a second problem, not a good state.
  const shownChips = input.outputSilent
    ? engineChips.map((chip) =>
        chip.tone === "ok" ? { ...chip, tone: "idle" as const } : chip,
      )
    : engineChips;

  // D7: with no song commanded, fresh audible output is never "Off air". It is Palazzo's fallback playlist only with
  // the same engine checks as On air and when the desk knows nothing else is on the air; otherwise it is generic.
  const audible =
    !live && input.outputAudible === true && input.outputUnverified !== true;
  const engineAirs = input.engine.connected && input.playoutDown !== true;
  const fallback = audible && engineAirs && input.otherAudio === "none";
  const offRundown = audible && engineAirs && !fallback;
  const audioUnconfirmed = audible && !engineAirs;

  const view: OnAirView = {
    state: fallback
      ? "fallback"
      : offRundown
      ? "off-rundown"
      : audioUnconfirmed
      ? "audio-unconfirmed"
      : !live && input.rotationEnded
      ? "rotation-ended"
      : !live
      ? "off-air"
      : unconfirmed
        ? "unconfirmed"
        : stale
          ? "delayed"
          : unverified
            ? "unverified"
            : "on-air",
    label: fallback
      ? "Fallback playlist on air"
      : offRundown || audioUnconfirmed
      ? "Audio on air · not from the rundown"
      : !live && input.rotationEnded
      ? "Rotation ended"
      : !live
      ? "Off air"
      : unconfirmed
        ? "Not confirmed"
        : stale
          ? "Status delayed"
          : unverified
            ? "Unverified"
            : "On air",
    // While a jingle is on, the song after it has not started: it is not named as on air, and has no clock.
    jingle: jingling,
    title: commandedJingle ? `Jingle · ${playback!.jingle!.name}` : !live ? null : jingling ? `Jingle · ${playback!.jingle!.name}` : (playback!.title || "Title unavailable"),
    artist: commandedJingle ? "Then the next song" : !live ? null : jingling ? `Then ${playback!.title || "the next song"}${playback!.artist ? ` · ${playback!.artist}` : ""}` : (playback!.artist || "Artist unavailable"),
    elapsedMs: jingling ? null : clampedElapsed,
    remainingMs:
      !jingling && clampedElapsed !== null && hasLength
        ? (playback!.durationMs as number) - clampedElapsed
        : null,
    intro: live && !jingling ? introOf(playback!) : null,
    next: input.next
      ? {
          title: input.next.title,
          detail: input.next.sameSong
            ? "same song (loop of one)"
            : [
                live && playback!.jingleNext ? `after jingle ${playback!.jingleNext.name}` : null,
                input.next.artist,
                input.next.durationMs ? formatClock(input.next.durationMs) : null,
              ]
                .filter(Boolean)
                .join(" · "),
        }
      : null,
    // A queued song plays next whatever the rotation's mode: say so, not the mode (walk part 5).
    modeLabel: input.next?.via === "queue" ? "Play Next" : MODE_LABELS[input.mode],
    chips: shownChips,
  };
  return commandedJingle ? { ...view, state: "on-air", label: "On air" } : view;
}
