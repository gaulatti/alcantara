// The guest's own on-air state, from the studio's cue for their session (`cue` on the join and heartbeat responses).
// Only a live cue is on air; standby and wrap are off air. A missing value shows nothing rather than a guess.

export type GuestCue = "live" | "standby" | "wrap";

export function guestOnAirCopy(cue: GuestCue): { title: string; body: string; onAir: boolean } {
  if (cue === "live") {
    return { title: "You're on air", body: "The studio is sending you to air now.", onAir: true };
  }
  return { title: "Off air", body: "You are not on air. The producer can still see and hear you.", onAir: false };
}

/** A large, unmissable banner. Polite live region, so a change is read out once. */
export function GuestOnAirState({ cue }: { cue: GuestCue }) {
  const copy = guestOnAirCopy(cue);
  return (
    <div
      role="status"
      aria-live="polite"
      data-on-air={copy.onAir ? "true" : "false"}
      className={
        copy.onAir
          ? "mb-4 rounded-2xl border-2 border-red-400 bg-red-600 px-5 py-4 text-center text-white"
          : "mb-4 rounded-2xl border-2 border-white/30 bg-zinc-900 px-5 py-4 text-center text-white"
      }
    >
      <p className="text-3xl font-bold uppercase tracking-wider">{copy.title}</p>
      <p className="mt-1 text-sm text-white/80">{copy.body}</p>
    </div>
  );
}
