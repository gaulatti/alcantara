/**
 * The caller desk (gaulatti/alcantara#301, #291 group 2), over today's guest
 * data only. A guest's connection and the last cue the console sent are real;
 * screening, a per-guest on-air state and mic meters are not modelled yet, so
 * the desk never derives them.
 */
export const DESK_SLOTS = 6;
/** How long a guest strip stays armed before a second press is needed again. */
export const ARM_TIMEOUT_MS = 5_000;
/** How long "Hold · cue wrap" must be held. */
export const HOLD_MS = 800;

export type Cue = "standby" | "live" | "wrap";

export interface DeskCommand {
  type: string;
  payload: Record<string, unknown>;
}

/** The last cue the console sent (commands are newest first), or null. */
export function latestCue(commands: DeskCommand[]): Cue | null {
  const command = commands.find((item) => item.type === "cue");
  const cue = command?.payload.cue;
  return cue === "standby" || cue === "live" || cue === "wrap" ? cue : null;
}

export type StripState = "cued-live" | "connected" | "reconnecting" | "offline";

/**
 * A strip's state from its connection and last cue. "cued-live" means the guest
 * was sent the live cue; it is not a claim that the guest is in the output,
 * which only a scene carrying the guest does.
 */
export function stripState(
  connectionState: "connected" | "reconnecting" | "offline",
  cue: Cue | null,
): StripState {
  if (connectionState !== "connected") return connectionState;
  return cue === "live" ? "cued-live" : "connected";
}

/** The owner's four states, in plain words: connecting, live, dropped, left (with the live cue shown as "Live · cued"). */
export const STRIP_LABEL: Record<StripState, string> = {
  "cued-live": "Live · cued",
  connected: "Live",
  reconnecting: "Connecting",
  offline: "Dropped",
};

/** A slot with no one connected: a link waiting to be used, or a guest who was in the call and left. */
export function emptySlotLabel(invitationStatus: string): "Invited" | "Left" {
  return invitationStatus === "active" ? "Left" : "Invited";
}

export interface DeskSlot<TInvitation, TParticipant> {
  slot: number;
  invitation: TInvitation | null;
  participant: TParticipant | null;
}

/**
 * Slots 1 to 6, each with its live invitation and that invitation's
 * participant. A participant is matched by invitation id, never by slot
 * number, so one without an invitation of this program is never shown.
 */
export function deskSlots<
  TInvitation extends { id: string; slotNumber: number; status: string },
  TParticipant extends { invitationId: string },
>(invitations: TInvitation[], participants: TParticipant[]): DeskSlot<TInvitation, TParticipant>[] {
  return Array.from({ length: DESK_SLOTS }, (_, index) => {
    const slot = index + 1;
    const invitation =
      invitations.find(
        (item) =>
          item.slotNumber === slot &&
          item.status !== "revoked" &&
          item.status !== "expired",
      ) ?? null;
    return {
      slot,
      invitation,
      participant: invitation
        ? (participants.find((item) => item.invitationId === invitation.id) ?? null)
        : null,
    };
  });
}

/** "2:41" for how long something has lasted. */
export function elapsed(fromIso: string | null | undefined, now: number): string {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (!Number.isFinite(from)) return "—";
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
