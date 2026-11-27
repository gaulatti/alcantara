// What a guest sees of the studio's return (display only). The return is the program the server-side router sends as
// audio; the page shows only whether the guest is hearing it. No internal wording (no "return feed", no bus names).

export type GuestReturnState = "connecting" | "playing" | "dropped" | "stalled";

/** How long without the return before the guest is told it is not reaching them (admission, or a drop). */
export const RETURN_STALL_MS = 15_000;

/**
 * Before the first return is heard: connecting. Once heard, playing. After it stops: dropped, until it is back. If the
 * return is still missing after RETURN_STALL_MS (`stalled`), the guest is told so, until it arrives.
 */
export function guestReturnState({
  returnFeed,
  everPlayed,
  stalled = false,
}: {
  returnFeed: boolean;
  everPlayed: boolean;
  stalled?: boolean;
}): GuestReturnState {
  if (returnFeed) return "playing";
  if (stalled) return "stalled";
  return everPlayed ? "dropped" : "connecting";
}

/**
 * What the guest page reports to the studio on its heartbeat (the existing telemetry field, returnFeedHealth): healthy
 * while playing, stalled once the return has been missing for the stall time, missing otherwise.
 */
export function returnFeedHealthFor({ returnFeed, stalled }: { returnFeed: boolean; stalled: boolean }): "healthy" | "stalled" | "missing" {
  if (returnFeed) return "healthy";
  return stalled ? "stalled" : "missing";
}

export const GUEST_RETURN_COPY: Record<GuestReturnState, string> = {
  connecting: "Connecting you to the studio sound…",
  playing: "You're hearing the studio",
  dropped: "The studio sound dropped. It will come back by itself.",
  stalled: "The studio sound isn't reaching you yet. The producer can see this; you can keep talking.",
};
