import { currentCue, stripState, type DeskCommand } from "../../utils/callerDesk";
import type { OnAirChip } from "./onAir";

export interface DeskGuest {
  identity: string;
  name: string;
  connectionState: "connected" | "reconnecting" | "offline";
  /** Joined and not yet admitted. */
  screening?: boolean;
  commands?: DeskCommand[];
}

/**
 * The on-air strip's word on the call (alcantara#875): the strip never scrolls away, so at any screen height the
 * operator sees who is on air, who waits to be let in and who is on the call. Nothing when no one is.
 */
export function guestChip(guests: DeskGuest[]): OnAirChip | null {
  const waiting = guests.filter((guest) => guest.screening);
  const inCall = guests.filter((guest) => !guest.screening && guest.connectionState === "connected");
  const live = inCall.filter((guest) => stripState(guest.connectionState, currentCue(guest)) === "cued-live");
  const everyone = [...inCall, ...waiting];
  if (everyone.length === 0) return null;
  const parts = [
    live.length ? `${live.length} on air` : null,
    waiting.length ? `${waiting.length} waiting` : null,
    inCall.length - live.length ? `${inCall.length - live.length} off air` : null,
  ].filter(Boolean);
  return {
    id: "guests",
    tone: waiting.length ? "warn" : live.length ? "bad" : "info",
    label: everyone.length === 1 ? `${everyone[0].name}: ${waiting.length ? "waiting" : live.length ? "on air" : "off air"}` : `Guests: ${parts.join(", ")}`,
    title: everyone
      .map((guest) => `${guest.name}: ${guest.screening ? "waiting to be let in" : live.includes(guest) ? "cued live" : "on the call, off air"}`)
      .join("; "),
    href: "/calls",
  };
}
