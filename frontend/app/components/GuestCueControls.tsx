import { Button } from "@gaulatti/bleecker";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ARM_TIMEOUT_MS, CUE_LINE, HOLD_MS, type Cue, type CueState } from "../utils/callerDesk";

/**
 * The cue controls a guest call needs wherever the operator is (Guest calls and the radio desk, gaulatti/alcantara#879):
 * Standby at once, Cue live armed by one press and sent by a second (or Space while armed), Wrap only after a full hold.
 * The state lives in a hook, so a page can send Space from a wider area than the row (a whole strip).
 */
export function useGuestCue(onCue: (cue: Cue) => void) {
  const [armed, setArmed] = useState(false);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const send = useRef(onCue);
  send.current = onCue;

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    },
    [],
  );

  const cueLive = useCallback(() => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    send.current("live");
  }, [armed]);
  const startHold = useCallback(() => {
    if (holdTimer.current !== null) return;
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setHolding(false);
      send.current("wrap");
    }, HOLD_MS);
  }, []);
  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  }, []);
  /** Space while armed sends the live cue; returns whether it did, so the caller can stop the key there. */
  const spaceWhileArmed = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== " " || !armed) return false;
      event.preventDefault();
      cueLive();
      return true;
    },
    [armed, cueLive],
  );

  return { armed, holding, cueLive, startHold, cancelHold, spaceWhileArmed, standby: () => send.current("standby") };
}

export type GuestCueHandle = ReturnType<typeof useGuestCue>;

/**
 * The cue row: what cue holds, and the three cue buttons. It sits where nothing appears or disappears above it, so a
 * button never moves under a finger between the two presses of Cue live.
 */
export function GuestCueButtons({
  cue,
  disabled,
  controls,
  spaceSendsLive = true,
}: {
  cue: CueState | null;
  disabled: boolean;
  controls: GuestCueHandle;
  /**
   * Whether Space sends an armed live cue here. Not on the radio desk, where Space is the transport's Take
   * (gaulatti/alcantara#879): there the second press is the only way, and the label says so.
   */
  spaceSendsLive?: boolean;
}) {
  const { armed, holding, cueLive, startHold, cancelHold, standby } = controls;
  return (
    <div className="guest-strip-row">
      <span className="guest-strip-cue">{cue ? CUE_LINE[cue] : "Cue · none sent"}</span>
      {/* data-own-space: a Space press on a cue button is that button's, never the desk transport's Take. */}
      <Button size="xs" variant="secondary" disabled={disabled} onClick={standby} data-own-space="true">
        Standby
      </Button>
      <Button
        size="xs"
        variant={armed ? "destructive" : "secondary"}
        disabled={disabled}
        aria-pressed={armed}
        data-own-space="true"
        // One width for both states, so arming does not widen the button or push the next one to another line.
        className="min-w-[13rem] whitespace-nowrap"
        onClick={cueLive}
      >
        {armed ? (spaceSendsLive ? "Press again or Space: cue live" : "Press again: cue live") : "Cue live"}
      </Button>
      <Button
        size="xs"
        variant="secondary"
        disabled={disabled}
        data-holding={holding}
        data-own-space="true"
        className="whitespace-nowrap"
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
            event.preventDefault();
            startHold();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === "Enter" || event.key === " ") cancelHold();
        }}
        title="Hold to send the wrap cue"
      >
        {holding ? "Keep holding…" : "Hold · cue wrap"}
      </Button>
    </div>
  );
}
