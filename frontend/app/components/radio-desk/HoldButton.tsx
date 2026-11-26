import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useHoldToConfirm } from "./holdToConfirm";

/**
 * A control that acts only when held for `holdMs`, with a fill that shows the progress. A quick
 * click does nothing but say how to use it. Enter or Space held on the focused control hold it too.
 */
export function HoldButton({
  label,
  hint,
  holdMs = 600,
  onConfirm,
  disabled = false,
  tone = "default",
  globalKey,
  children,
}: {
  label: string;
  /** Read out and shown when the control is pressed without holding. */
  hint: string;
  holdMs?: number;
  onConfirm: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  /**
   * A window-wide key that holds the control too (for example ⌥.): holding it for `holdMs` acts,
   * releasing it early cancels. Ignored while a field has the focus.
   */
  globalKey?: (event: globalThis.KeyboardEvent) => boolean;
  children?: ReactNode;
}) {
  const [tapped, setTapped] = useState(false);
  const { progress, begin: beginHold, end, cancel } = useHoldToConfirm({
    holdMs,
    onConfirm,
    onTap: () => {
      setTapped(true);
      setTimeout(() => setTapped(false), 2_500);
    },
  });
  // A disabled control never starts a hold, and one that becomes disabled mid-hold drops it, so a hold
  // can never act after the control stopped allowing it (gaulatti/alcantara#693 review). Pointer
  // events can still reach a disabled button, so the check cannot rely on the browser alone.
  const begin = useCallback(() => {
    if (!disabled) beginHold();
  }, [beginHold, disabled]);
  useEffect(() => {
    if (disabled) cancel();
  }, [cancel, disabled]);
  useEffect(() => {
    if (!globalKey || disabled) return;
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || typing(event.target) || !globalKey(event)) return;
      event.preventDefault();
      begin();
    };
    const up = (event: globalThis.KeyboardEvent) => {
      // Releasing the letter or the modifier ends the hold.
      if (
        globalKey(event) ||
        event.key === "Alt" ||
        event.key === "." ||
        event.code === "Period"
      )
        end();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [begin, disabled, end, globalKey]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      begin();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      end();
    }
  };
  return (
    <span className="relative inline-flex flex-col">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tapped ? `hold-${label}` : undefined}
        disabled={disabled}
        data-holding={progress > 0}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={cancel}
        className={`relative inline-flex h-9 items-center gap-1.5 overflow-hidden rounded-[7px] border px-3 text-xs font-semibold uppercase tracking-wide disabled:opacity-40 ${tone === "danger" ? "border-terracotta/60 text-terracotta" : "border-sand/50 text-text-primary"}`}
      >
        <span
          aria-hidden="true"
          data-testid="hold-fill"
          className={`absolute inset-y-0 left-0 ${tone === "danger" ? "bg-terracotta/50" : "bg-accent-blue/40"}`}
          style={{ width: `${progress * 100}%` }}
        />
        <span className="relative inline-flex items-center gap-1.5">
          {children ?? label}
        </span>
      </button>
      {tapped ? (
        <span
          id={`hold-${label}`}
          role="status"
          className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap text-[11px] text-amber-200"
        >
          {hint}
        </span>
      ) : null}
    </span>
  );
}
