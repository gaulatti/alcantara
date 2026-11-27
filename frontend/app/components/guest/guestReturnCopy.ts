// What a guest sees of the studio's return (display only). The return is the program the server-side router sends as
// audio; the page shows only whether the guest is hearing it. No internal wording (no "return feed", no bus names).

export type GuestReturnState = "connecting" | "playing" | "dropped";

/** Before the first return is heard: connecting. Once heard, playing; after it stops: dropped, until it is back. */
export function guestReturnState({ returnFeed, everPlayed }: { returnFeed: boolean; everPlayed: boolean }): GuestReturnState {
  if (returnFeed) return "playing";
  return everPlayed ? "dropped" : "connecting";
}

export const GUEST_RETURN_COPY: Record<GuestReturnState, string> = {
  connecting: "Connecting you to the studio sound…",
  playing: "You're hearing the studio",
  dropped: "The studio sound dropped. It will come back by itself.",
};
