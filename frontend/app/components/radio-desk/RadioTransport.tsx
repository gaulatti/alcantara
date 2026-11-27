import { useCallback, useEffect, useState, type ReactNode } from "react";
import { HoldButton } from "./HoldButton";
import type { NextUpSong } from "./songs";
import { KeyCap, StatePill } from "./primitives";
import { useArmed } from "./useArmed";

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The radio desk's transport: Cue next (N) arms the song that plays next, Take (Space) puts it on
 * air, holding Stop (⌥.) takes the song off air (the cartwall has its own hold-to-stop-all). One press
 * never takes: a song is cued first, and an armed cue clears itself after five seconds or on Esc.
 */
export function RadioTransport({
  next,
  onTake,
  onTakeOffAir,
  onListen,
  listening,
  keysEnabled = true,
  engineUnavailable = null,
  confirmedItemId = null,
  monitor,
}: {
  next: NextUpSong | null;
  onTake: (song: NextUpSong) => Promise<void> | void;
  onTakeOffAir: () => Promise<void> | void;
  /** Toggles the operator's own monitor (M). */
  onListen?: () => void;
  listening?: boolean;
  /** False while another layer (a dialog) owns the keyboard. */
  keysEnabled?: boolean;
  /**
   * Why the playout engine cannot play (the on-air strip's engine label), or null when it is
   * connected. While set, Take is refused here and nothing is sent (gaulatti/alcantara#609).
   */
  engineUnavailable?: string | null;
  /** The rotation item the engine has confirmed on air, or null. Ends the "waiting" state. */
  confirmedItemId?: string | null;
  /** The desk's one listen control (Listen with its key and volume), at the transport's right. M still toggles it. */
  monitor?: ReactNode;
}) {
  const { armed, arm, take, disarm } = useArmed<NextUpSong>();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The song taken last, until the engine confirms it on air.
  const [waitingFor, setWaitingFor] = useState<NextUpSong | null>(null);
  // Set once a stop is confirmed; the status line announces it, and the next cue or take clears it.
  const [stopped, setStopped] = useState(false);
  // The taken song once the engine confirms it; the status line says "On air: <title>." until the
  // next cue, take or stop (gaulatti/alcantara#688).
  const [onAir, setOnAir] = useState<NextUpSong | null>(null);

  useEffect(() => {
    if (waitingFor && confirmedItemId === waitingFor.itemId) {
      setOnAir(waitingFor);
      setWaitingFor(null);
    }
  }, [confirmedItemId, waitingFor]);
  // Once the engine no longer confirms the taken song (it ended, automation moved on, the engine stopped it), the
  // line stops naming it: a stale On air is never announced (Wakko's #781 review).
  useEffect(() => {
    if (onAir && confirmedItemId !== onAir.itemId) setOnAir(null);
  }, [confirmedItemId, onAir]);

  const cue = useCallback(() => {
    setError(null);
    setStopped(false);
    setOnAir(null);
    if (!next) {
      setNote("Nothing to cue.");
      return;
    }
    setNote(null);
    setWaitingFor(null);
    arm(next);
  }, [arm, next]);

  const takeCued = useCallback(async () => {
    const song = take();
    if (!song) {
      setNote("Cue first (N).");
      return;
    }
    setNote(null);
    setError(null);
    setStopped(false);
    setOnAir(null);
    if (engineUnavailable) {
      setWaitingFor(null);
      setNote(`${engineUnavailable}. Not taken.`);
      return;
    }
    try {
      await onTake(song);
      setWaitingFor(song);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The take was refused");
    }
  }, [engineUnavailable, onTake, take]);

  const stopSong = useCallback(async () => {
    setError(null);
    setStopped(false);
    try {
      await onTakeOffAir();
      setWaitingFor(null);
      setOnAir(null);
      setStopped(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The stop was refused");
    }
  }, [onTakeOffAir]);

  useEffect(() => {
    if (!keysEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey) return;
      if (event.altKey) return;
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        cue();
      } else if (event.key === " ") {
        // Space on "Clear cue" clears it; taking the song there would do the opposite.
        if (event.target instanceof HTMLElement && event.target.dataset.ownSpace) return;
        // Space also presses a focused button; the transport owns it only when a cue is armed.
        if (armed || !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault();
          void takeCued();
        }
      } else if (event.key === "Escape" && armed) {
        event.preventDefault();
        disarm();
        setNote(null);
      } else if ((event.key === "m" || event.key === "M") && onListen) {
        event.preventDefault();
        onListen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [armed, cue, disarm, keysEnabled, onListen, takeCued]);

  return (
    <div role="group" aria-label="Radio transport" className="desk-transport">
      <div className="desk-transport-keys">
        <button type="button" onClick={cue} className="desk-key">
          Cue next <KeyCap>N</KeyCap>
        </button>
        <button
          type="button"
          onClick={() => void takeCued()}
          disabled={!armed}
          data-armed={armed ? "true" : undefined}
          className="desk-key desk-key-take"
        >
          Take <KeyCap>Space</KeyCap>
        </button>
        {armed ? (
          <button
            type="button"
            data-own-space="true"
            aria-label="Clear cue"
            onClick={() => {
              disarm();
              setNote(null);
            }}
            className="desk-key"
          >
            Clear <KeyCap>Esc</KeyCap>
          </button>
        ) : null}
        <HoldButton
          label="Stop the song on air"
          hint="Hold to stop the song on air (0.6 s)."
          tone="danger"
          onConfirm={() => void stopSong()}
          globalKey={(event) =>
            keysEnabled && event.altKey && (event.code === "Period" || event.key === ".")
          }
        >
          Hold · stop <KeyCap keys={["⌥", "."]} />
        </HoldButton>
      </div>
      {/* The one polite live region for transport outcomes, terse: Cued, Taken, On air, Stopped, and faults. */}
      <div className="desk-transport-state" role="status" aria-live="polite">
        {armed ? (
          <span className="desk-state-arm">
            <StatePill tone="arm" label="Cued" />
            {/* One flex item: as separate ones the row's gap opened holes inside the sentence (#875). */}
            <span className="truncate">
              {armed.title} — {armed.artist}
              <span className="desk-state-hint"> · 5 s</span>
            </span>
          </span>
        ) : waitingFor ? (
          <span className="desk-state-arm">
            <StatePill tone="arm" label="Taken" />
            <span className="truncate">{waitingFor.title} · awaiting engine</span>
          </span>
        ) : stopped ? (
          <span>Stopped.</span>
        ) : onAir ? (
          <span className="truncate">On air: {onAir.title}.</span>
        ) : null}
        {engineUnavailable && !note ? (
          <span className="desk-fault-text">{engineUnavailable}. Take unavailable.</span>
        ) : null}
        {note ? <span className="desk-fault-text">{note}</span> : null}
        {error ? (
          <span role="alert" className="desk-fault-text">
            {error}
          </span>
        ) : null}
      </div>
      {monitor ??
        (onListen ? (
          <button type="button" onClick={onListen} aria-pressed={listening === true} className="desk-key">
            Listen <KeyCap>M</KeyCap>
          </button>
        ) : null)}
    </div>
  );
}
