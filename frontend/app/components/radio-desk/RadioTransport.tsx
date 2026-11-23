import { useCallback, useEffect, useState } from "react";
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
}: {
  next: NextUpSong | null;
  onTake: (song: NextUpSong) => Promise<void> | void;
  onTakeOffAir: () => Promise<void> | void;
  /** Toggles the operator's own monitor (M). */
  onListen?: () => void;
  listening?: boolean;
  /** False while another layer (a dialog) owns the keyboard. */
  keysEnabled?: boolean;
}) {
  const { armed, arm, take, disarm } = useArmed<NextUpSong>();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cue = useCallback(() => {
    setError(null);
    if (!next) {
      setNote("Nothing to cue: the rotation has no next song.");
      return;
    }
    setNote(null);
    arm(next);
  }, [arm, next]);

  const takeCued = useCallback(async () => {
    const song = take();
    if (!song) {
      setNote("Cue next (N) first, then Take.");
      return;
    }
    setNote(null);
    setError(null);
    try {
      await onTake(song);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The take was refused");
    }
  }, [onTake, take]);

  const stopSong = useCallback(async () => {
    setError(null);
    try {
      await onTakeOffAir();
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
    <div
      role="group"
      aria-label="Radio transport"
      className="flex flex-wrap items-center gap-3 border-t border-sand/30 bg-deep-sea/95 px-4 py-2.5"
    >
      <button
        type="button"
        onClick={cue}
        className="inline-flex h-9 items-center gap-2 rounded-[7px] border border-sand/50 px-3 text-xs font-semibold uppercase tracking-wide"
      >
        Cue next <KeyCap>N</KeyCap>
      </button>
      <button
        type="button"
        onClick={() => void takeCued()}
        disabled={!armed}
        className={`inline-flex h-9 items-center gap-2 rounded-[7px] border px-4 text-xs font-bold uppercase tracking-wide disabled:opacity-40 ${armed ? "border-accent-red bg-accent-red text-white" : "border-sand/50"}`}
      >
        Take <KeyCap>Space</KeyCap>
      </button>
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
      {onListen ? (
        <button
          type="button"
          onClick={onListen}
          aria-pressed={listening === true}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-[7px] border border-sand/50 px-3 text-xs font-semibold"
        >
          Listen <KeyCap>M</KeyCap>
        </button>
      ) : null}
      <div className="basis-full text-xs" role="status">
        {armed ? (
          <span className="inline-flex items-center gap-2 text-accent-yellow">
            <StatePill tone="arm" label="Cued" />
            {armed.title} — {armed.artist}. Take or press Space within 5 s; Esc
            clears it.
          </span>
        ) : (
          <span className="text-text-secondary">
            {next
              ? `Next: ${next.title}. Cue next (N), then Take (Space).`
              : "Nothing cued."}
          </span>
        )}
        {note ? <span className="ml-2 text-amber-200">{note}</span> : null}
      </div>
      {error ? (
        <p role="alert" className="basis-full text-xs text-terracotta">
          {error}
        </p>
      ) : null}
    </div>
  );
}
