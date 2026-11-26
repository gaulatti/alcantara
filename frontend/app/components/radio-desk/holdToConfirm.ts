import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Press and hold to confirm: `progress` runs from 0 to 1 over `holdMs`, and `onConfirm` fires once
 * when it reaches 1. Releasing early cancels. A quick press does nothing but report it through
 * `onTap`, so the control can say how to use it. `reduceMotion` skips the animation frames: the
 * hold still has to last `holdMs`.
 */
export function useHoldToConfirm({
  holdMs,
  onConfirm,
  onTap,
}: {
  holdMs: number;
  onConfirm: () => void;
  onTap?: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const confirm = useRef(onConfirm);
  confirm.current = onConfirm;

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    startedAt.current = null;
    setProgress(0);
  }, []);

  const begin = useCallback(() => {
    if (startedAt.current !== null) return;
    const start = performance.now();
    startedAt.current = start;
    // Each frame measures from this hold's own start, so a frame can never read a hold that has ended.
    const step = (now: number) => {
      // A frame from a hold that has ended or been replaced must never confirm.
      if (startedAt.current !== start) return;
      const ratio = Math.min(1, (now - start) / holdMs);
      setProgress(ratio);
      if (ratio >= 1) {
        frame.current = null;
        startedAt.current = null;
        setProgress(0);
        confirm.current();
        return;
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [holdMs]);

  const end = useCallback(() => {
    if (startedAt.current === null) return;
    stop();
    onTap?.();
  }, [onTap, stop]);

  useEffect(() => stop, [stop]);

  return { progress, begin, end, cancel: stop, holding: progress > 0 };
}
