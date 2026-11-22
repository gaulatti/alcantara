/**
 * The director's program return (gaulatti/alcantara#301, #291 group 2).
 *
 * The PROGRAM monitor today is the program page rendered again in the
 * director's own browser, silent (output gain 0): it has no latency, no loss
 * and no audio, so it is never the output. A real return (from Alana, or the
 * Tauri pilot) does not exist yet; when one does, it reports how late its last
 * frame is and when that frame arrived, and these states describe it.
 *
 * The thresholds are the proposal's, for the owner to set; they are not stored.
 */
export const RETURN_DELAYED_MS = 3_000;
export const RETURN_FROZEN_MS = 2_000;

export type ReturnSource =
  /** No real return: the local render is shown, labelled as not the output. */
  | { kind: "local" }
  | {
      kind: "return";
      /** Where it comes from, as the tile names it (for example "Alana"). */
      from: string;
      /** The return's connection is up. */
      connected: boolean;
      /** How far the last frame is behind the program, in ms. */
      latencyMs: number | null;
      /** When the last new frame arrived (ms since the epoch). */
      lastFrameAt: number | null;
    };

export type ReturnState = "local" | "live" | "delayed" | "frozen" | "lost";

export function returnState(source: ReturnSource, now: number): ReturnState {
  if (source.kind === "local") return "local";
  if (!source.connected || source.lastFrameAt === null) return "lost";
  if (now - source.lastFrameAt >= RETURN_FROZEN_MS) return "frozen";
  if (source.latencyMs !== null && source.latencyMs > RETURN_DELAYED_MS)
    return "delayed";
  return "live";
}

export const RETURN_STATE_LABEL: Record<ReturnState, string> = {
  local: "Local render · not the output",
  live: "Live",
  delayed: "Delayed",
  frozen: "Frozen",
  lost: "Signal lost",
};

/** "1.8 s behind", or null when the latency is unknown. */
export function behindLabel(latencyMs: number | null): string | null {
  if (latencyMs === null) return null;
  return `${(latencyMs / 1000).toFixed(1)} s behind`;
}

/** "0:07" since a moment, for the frozen and lost timers. */
export function sinceLabel(from: number | null, now: number): string {
  if (from === null) return "—";
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
