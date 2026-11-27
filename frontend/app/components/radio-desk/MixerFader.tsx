import { useRef } from "react";
import { dbToFader, faderToDb } from "../../utils/audioTaper";

/** The browser's range thumb, which the drag handle sits over. */
const THUMB_PX = 16;
/** The drag handle: wider than the thumb, a touch target. */
const HANDLE_PX = 24;
/** Keys that jump the native range to an end or by a page: on air, a fader never jumps. */
const JUMP_KEYS = new Set(["Home", "End", "PageUp", "PageDown"]);

/**
 * A mixer fader that moves only when its handle is dragged or a key steps it (walk part 4: one stray click on the track
 * moved on-air music to −45.6 dB). The native range stays for the keyboard and screen readers but takes no pointer
 * input, so a click on the track does nothing; the handle over the thumb moves the level by how far it is dragged, not
 * to where it is grabbed. Arrow keys move one decibel; Home, End and the page keys do nothing.
 */
export function MixerFader({
  label,
  value,
  onChange,
}: {
  label: string;
  /** Fader position, 0 to 1. */
  value: number;
  onChange: (value: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; value: number; pointerId: number } | null>(null);
  const clamp = (next: number) => Math.max(0, Math.min(1, next));
  const db = faderToDb(value);

  return (
    <div ref={track} className="relative">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        // Only the keyboard reaches it: a pointer on the track does nothing.
        style={{ pointerEvents: "none" }}
        onChange={(event) => onChange(Number(event.target.value))}
        onKeyDown={(event) => {
          if (JUMP_KEYS.has(event.key)) {
            event.preventDefault();
            return;
          }
          const up = event.key === "ArrowUp" || event.key === "ArrowRight";
          const down = event.key === "ArrowDown" || event.key === "ArrowLeft";
          if (!up && !down) return;
          // One decibel per press, not one hundredth of the travel.
          event.preventDefault();
          const current = Number.isFinite(db) ? db : -80;
          onChange(clamp(dbToFader(current + (up ? 1 : -1))));
        }}
        aria-label={label}
      />
      <div
        aria-hidden="true"
        data-testid="fader-handle"
        className="absolute top-0 h-full cursor-grab touch-none active:cursor-grabbing"
        style={{
          width: HANDLE_PX,
          left: `calc(${value} * (100% - ${THUMB_PX}px) + ${THUMB_PX / 2 - HANDLE_PX / 2}px)`,
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, value, pointerId: event.pointerId };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          const width = track.current?.getBoundingClientRect().width ?? 0;
          if (!start || start.pointerId !== event.pointerId || width <= THUMB_PX) return;
          onChange(clamp(start.value + (event.clientX - start.x) / (width - THUMB_PX)));
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
    </div>
  );
}
