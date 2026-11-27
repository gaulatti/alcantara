/**
 * The call chain's health (gaulatti/alcantara#875): GET /webrtc/health?programId= answers
 * { returnRunner, contribution, livekit: ok | down | unknown, checkedAt }. Only an explicit "down" is ever said:
 * unknown, a missing endpoint or a failed read stays quiet.
 */
export interface CallHealthWarning {
  /** What is broken, in plain words. */
  problem: string;
  /** What the operator can do about it now. */
  action: string;
}

/** One warning for what the answer says is down, the most upstream first, or null when there is nothing to say. */
export function callHealthWarning(health: unknown): CallHealthWarning | null {
  const down = (part: string) => (health as Record<string, unknown> | null)?.[part] === "down";
  // Nothing works without the calls server, so it is the only thing said.
  if (down("livekit"))
    return {
      problem: "Calls server unreachable",
      action: "Guests can't join or be heard. Carry on without callers until this line clears.",
    };
  const air = down("contribution");
  const studio = down("returnRunner");
  if (air && studio)
    return {
      problem: "Guests can't reach air or hear the studio right now",
      action: "Don't cue anyone live. Talk to them with Hold · talk, or send a private message.",
    };
  if (air)
    return {
      problem: "Guests can't reach air right now",
      action: "Don't cue anyone live. Keep the programme going and wait for this line to clear.",
    };
  if (studio)
    return {
      problem: "Guests can't hear the studio right now",
      action: "Hold off cueing them live. Talk to them with Hold · talk, or send a private message.",
    };
  return null;
}
