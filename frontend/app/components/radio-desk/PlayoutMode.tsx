import { Repeat2, Shuffle } from "lucide-react";
import {
  shuffleProgramSongSequence,
  type ProgramSongSequence,
} from "../../utils/programSequence";

/**
 * Manual, Autoplay, Shuffle and Loop, above the rotation they change. Each choice builds the same
 * sequence the bottom bar built before, so the saved rotation is unchanged by where the control is.
 */
export function PlayoutMode({
  sequence,
  activeItemId,
  playing,
  onChange,
}: {
  sequence: ProgramSongSequence;
  /** The song on air, or the selected one. */
  activeItemId: string | null;
  playing: boolean;
  onChange: (next: ProgramSongSequence) => void;
}) {
  const setMode = (mode: "manual" | "autoplay") =>
    onChange({
      ...sequence,
      mode,
      activeItemId: activeItemId ?? sequence.activeItemId,
      startedAt: Date.now(),
    });
  const button = (pressed: boolean) =>
    `inline-flex h-7 items-center gap-1 rounded-[6px] px-2.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${pressed ? "bg-accent-blue/20 text-accent-blue" : "text-text-secondary hover:text-text-primary"}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="Playback mode"
        className="inline-flex gap-0.5 rounded-[7px] border border-sand/40 p-0.5"
      >
        <button
          type="button"
          aria-pressed={sequence.mode === "manual"}
          onClick={() => setMode("manual")}
          className={button(sequence.mode === "manual")}
        >
          Manual
        </button>
        <button
          type="button"
          aria-pressed={sequence.mode === "autoplay"}
          onClick={() => setMode("autoplay")}
          className={button(sequence.mode === "autoplay")}
        >
          Autoplay
        </button>
        <button
          type="button"
          aria-label="Shuffle playlist"
          aria-pressed={sequence.mode === "shuffle"}
          disabled={sequence.items.length < 2}
          title={
            sequence.mode === "shuffle"
              ? "Shuffle is active; reshuffle playlist"
              : "Activate shuffle"
          }
          onClick={() => {
            const shuffled = shuffleProgramSongSequence(
              sequence,
              activeItemId ?? sequence.activeItemId ?? null,
            );
            onChange(playing ? shuffled : { ...shuffled, startedAt: Date.now() });
          }}
          className={button(sequence.mode === "shuffle")}
        >
          <Shuffle size={11} /> Shuffle
        </button>
      </div>
      <button
        type="button"
        aria-label={`Loop playlist: ${sequence.loop !== false ? "on" : "off"}`}
        aria-pressed={sequence.loop !== false}
        onClick={() =>
          onChange({ ...sequence, loop: sequence.loop === false ? true : false })
        }
        className={`${button(sequence.loop !== false)} border border-sand/40`}
      >
        <Repeat2 size={12} /> Loop {sequence.loop !== false ? "on" : "off"}
      </button>
    </div>
  );
}
