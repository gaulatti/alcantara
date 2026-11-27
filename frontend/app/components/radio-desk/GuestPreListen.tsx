import { useCallback, useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";
import { authFetch } from "../../services/api";
import { TooltipButton } from "../BleeckerButtons";
import { createGuestPreListen, type GuestPreListenState } from "./guestPreListenCore";
import type { DeskGuest } from "./guestChip";

// The guests on the desk and a pre-fade listen button for each connected one (gaulatti/alcantara#835). The operator's
// room is joined with autoSubscribe off and nothing is published into it: see guestPreListen.ts.

type GuestRow = DeskGuest;

/** How often the guest list is read again while the desk is open. */
const GUEST_REFRESH_MS = 10_000;

export function GuestPreListen({
  programId,
  onActive,
  activeOwner = null,
  onGuests,
}: {
  programId: string;
  onActive: (channel: string, active: boolean) => void;
  /** The pre-fade that holds the desk now: a listened guest stops when another claims it. */
  activeOwner?: string | null;
  /** The list as it was last read, for the on-air strip. */
  onGuests?: (guests: DeskGuest[]) => void;
}) {
  const [guests, setGuests] = useState<GuestRow[]>([]);
  const [state, setState] = useState<GuestPreListenState>({ status: "idle" });
  const roomRef = useRef<Room | null>(null);
  const controllerRef = useRef<ReturnType<typeof createGuestPreListen> | null>(null);
  // True while this component moves from one guest to another, so the room stays joined across the change.
  const switching = useRef(false);
  const report = useRef(onActive);
  report.current = onActive;
  const share = useRef(onGuests);
  share.current = onGuests;

  const loadGuests = useCallback(async () => {
    try {
      const response = await authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants`);
      if (!response.ok) return;
      const body = (await response.json()) as { participants?: GuestRow[] };
      setGuests(body.participants ?? []);
      share.current?.(body.participants ?? []);
    } catch {
      // The list is read again on the next tick; a missed read keeps the last one on screen.
    }
  }, [programId]);

  useEffect(() => {
    void loadGuests();
    const timer = window.setInterval(() => void loadGuests(), GUEST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadGuests]);

  // Joins the operator's room on the first use, with autoSubscribe off. Only the chosen guest is subscribed to.
  const ensureRoom = useCallback(async () => {
    if (controllerRef.current) return controllerRef.current;
    const response = await authFetch("/webrtc/operator-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programId }),
    });
    if (!response.ok) throw new Error("The studio room is not available for listening.");
    const creds = (await response.json()) as { serverUrl: string; token: string };
    const room = new Room();
    await room.connect(creds.serverUrl, creds.token, { autoSubscribe: false });
    roomRef.current = room;
    controllerRef.current = createGuestPreListen(room as never, (next) => {
      setState(next);
      report.current("guest", next.status === "listening");
      // Off the desk's pre-fade, the room is left: nothing stays joined for a stopped listen.
      if (next.status === "idle" && !switching.current) {
        roomRef.current?.disconnect();
        roomRef.current = null;
        controllerRef.current = null;
      }
    });
    return controllerRef.current;
  }, [programId]);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
  }, []);

  const toggle = useCallback(
    async (identity: string) => {
      if (controllerRef.current?.identity === identity) {
        stop();
        return;
      }
      // Claim the desk before joining, so any other pre-fade stops now.
      report.current("guest", true);
      try {
        const controller = await ensureRoom();
        switching.current = true;
        try {
          controller.start(identity);
        } finally {
          switching.current = false;
        }
      } catch (error) {
        report.current("guest", false);
        setState({
          status: "error",
          identity,
          message: error instanceof Error ? error.message : "The guest could not be listened to here.",
        });
      }
    },
    [ensureRoom, stop],
  );

  // Another pre-fade took the desk: a guest being listened to stops.
  useEffect(() => {
    if (activeOwner === null || activeOwner === "guest") return;
    if (state.status === "listening") stop();
    else if (state.status === "error") setState({ status: "idle" });
  }, [state.status, activeOwner, stop]);

  // Esc stops it, as the other pre-listens do, and leaving the desk disconnects.
  useEffect(() => {
    if (state.status !== "listening") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, stop]);

  useEffect(
    () => () => {
      controllerRef.current?.stop();
      roomRef.current?.disconnect();
    },
    [],
  );

  const connected = guests.filter((guest) => guest.connectionState === "connected");

  return (
    <section aria-label="Guest pre-fade listen" className="space-y-2">
      <h3 className="text-sm font-medium">Guests</h3>
      {connected.length === 0 ? <p className="text-xs text-text-secondary">No guest is connected.</p> : null}
      <ul className="space-y-1">
        {connected.map((guest) => {
          const on = state.status === "listening" && state.identity === guest.identity;
          return (
            <li key={guest.identity} className="flex items-center gap-2">
              <span className="flex-1 truncate text-sm">{guest.name}</span>
              <TooltipButton
                type="button"
                aria-label={`Pre-listen ${guest.name}`}
                aria-pressed={on}
                title={`Hear ${guest.name} on this device only; nothing goes to air or to the guest`}
                onClick={() => void toggle(guest.identity)}
              >
                PFL
              </TooltipButton>
            </li>
          );
        })}
      </ul>
      {state.status === "listening" ? (
        <p role="status" className="text-[10px] text-accent-yellow">
          PFL · {guests.find((guest) => guest.identity === state.identity)?.name ?? "guest"} · this device only
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-[10px] text-accent-yellow">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
