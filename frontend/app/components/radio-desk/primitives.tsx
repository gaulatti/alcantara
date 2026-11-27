import type { ReactNode } from "react";

// The pieces of the radio desk that bleecker#549 proposes as shared components (StatePill, KeyCap,
// Meter). Their prop shapes are the ones pinned in that proposal, so that when bleecker#551
// publishes them the desk can swap these for the Bleecker ones without changing a call site.

export type StatePillTone =
  | "live"
  | "ok"
  | "warn"
  | "bad"
  | "arm"
  | "info"
  | "idle";

const PILL_TONES: Record<StatePillTone, string> = {
  live: "border-accent-red bg-accent-red text-white",
  ok: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-300/35 bg-amber-300/10 text-amber-200",
  bad: "border-terracotta/40 bg-terracotta/10 text-terracotta",
  arm: "border-accent-yellow bg-transparent text-accent-yellow",
  info: "border-accent-blue/35 bg-accent-blue/10 text-accent-blue",
  idle: "border-sand/30 bg-transparent text-text-secondary",
};

export function StatePill({
  tone,
  label,
  pulse = false,
  title,
  live = false,
}: {
  tone: StatePillTone;
  label: string;
  pulse?: boolean;
  title?: string;
  live?: boolean;
}) {
  return (
    <span
      data-tone={tone}
      title={title}
      role={live ? "status" : undefined}
      className={`inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-semibold ${PILL_TONES[tone]}`}
    >
      <i
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "motion-safe:animate-pulse" : ""}`}
      />
      {label}
    </span>
  );
}

export function KeyCap({
  children,
  keys,
}: {
  children?: ReactNode;
  keys?: string[];
}) {
  const caps = keys ?? [children];
  return (
    <>
      {caps.map((cap, index) => (
        <kbd
          key={index}
          className="inline-flex pointer-coarse:hidden h-5 min-w-5 items-center justify-center rounded-[5px] border border-b-2 border-sand/50 bg-dark-sand px-1.5 font-mono text-[11px] font-semibold text-text-secondary"
        >
          {cap}
        </kbd>
      ))}
    </>
  );
}

/**
 * A reading and its scale. `value`, `peak` and `hold` share the min..max scale; `peak` and `hold`
 * are the live level and its held maximum, and `warnFrom` colours the top of the scale.
 */
export function Meter({
  label,
  unit,
  value,
  min,
  max,
  warnFrom,
  peak,
  hold,
}: {
  label: string;
  unit?: string;
  value: number | null;
  min: number;
  max: number;
  warnFrom?: number;
  peak?: number | null;
  hold?: number | null;
}) {
  const span = max - min;
  const at = (reading: number) =>
    span > 0
      ? Math.max(0, Math.min(100, ((reading - min) / span) * 100))
      : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value ?? min}
      aria-valuetext={
        value === null ? "No level" : `${value.toFixed(1)}${unit ? ` ${unit}` : ""}`
      }
      className="relative h-1.5 overflow-hidden rounded-full bg-sand/25"
    >
      {warnFrom !== undefined ? (
        <span
          data-testid="meter-warn"
          className="absolute inset-y-0 right-0 bg-terracotta/35"
          style={{ left: `${at(warnFrom)}%` }}
        />
      ) : null}
      {value !== null ? (
        <span
          data-testid="meter-fill"
          className="absolute inset-y-0 left-0 bg-accent-blue"
          style={{ width: `${at(value)}%` }}
        />
      ) : null}
      {peak !== undefined && peak !== null ? (
        <span
          data-testid="meter-peak"
          className="absolute inset-y-0 w-0.5 bg-white/80"
          style={{ left: `calc(${at(peak)}% - 1px)` }}
        />
      ) : null}
      {hold !== undefined && hold !== null ? (
        <span
          data-testid="meter-hold"
          className={`absolute inset-y-0 w-0.5 ${warnFrom !== undefined && hold >= warnFrom ? "bg-terracotta" : "bg-accent-yellow"}`}
          style={{ left: `calc(${at(hold)}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}
