import { useEffect, useState, type ReactNode } from "react";
import { deriveOnAir, formatClock, type OnAirChip, type OnAirInput, type OnAirView } from "./onAir";
import { StatePill } from "./primitives";
import { useOutputUnverified } from "./useOutputUnverified";
import { Link } from "react-router";
import { guestChip, type DeskGuest } from "./guestChip";

/**
 * The strip as the desk mounts it: it reads the output's freshness itself, so the once-a-second tick renders the
 * strip and not the desk around it (gaulatti/alcantara#706).
 */
export function LiveOnAirStrip({
  input,
  output,
  programId,
  guests = [],
  controls,
  uptime = null,
}: {
  input: Omit<OnAirInput, "outputUnverified">;
  /** How long the stream has been up, for the status detail. */
  uptime?: string | null;
  output: { state: string; lastSampleAt: string | null } | null;
  programId: string;
  guests?: DeskGuest[];
  /** What the operator works from the strip itself, in view at every size. */
  controls?: ReactNode;
}) {
  const outputUnverified = useOutputUnverified(output);
  const view = deriveOnAir({ ...input, outputUnverified });
  const call = guestChip(guests);
  // The output reading the right column used to show, as one more line of the status dot (it was its own panel).
  // No reading at all (the endpoint is unreachable or refused) is unverified, as the output panel said.
  const outputChip: OnAirChip = !output
    ? { id: "output", tone: "warn", label: "Output unverified" }
    : outputUnverified
      ? { id: "output", tone: "warn", label: "Output unverified" }
      : output.state === "audible"
        ? { id: "output", tone: "ok", label: "Engine audio detected" }
        : output.state === "unavailable"
          ? { id: "output", tone: "warn", label: "Output unavailable" }
          : output.state === "checking"
            ? { id: "output", tone: "idle", label: "Checking output" }
            : output.state === "idle"
              ? { id: "output", tone: "idle", label: "Output idle" }
              : output.state === "silent"
                ? { id: "output", tone: "idle", label: "Expected audio is silent" }
                : { id: "output", tone: "warn", label: "Output unverified" };
  const chips = [...(call ? [call] : []), ...view.chips, outputChip];
  const sample = output?.lastSampleAt ? new Date(output.lastSampleAt).toLocaleTimeString(undefined, { hour12: false }) : null;
  return (
    <OnAirStrip
      view={{ ...view, chips }}
      programId={programId}
      controls={controls}
      sample={sample}
      uptime={uptime}
    />
  );
}

/** Dead air, impossible to miss, with the advice one press away (gaulatti/alcantara#879). */
function DeadAirPill() {
  const showAdvice = () => {
    const advice = document.querySelector<HTMLElement>('[role="alert"][aria-label="Dead air"]');
    advice?.scrollIntoView({ block: "center" });
    advice?.focus();
  };
  return (
    <span role="status">
      <button
        type="button"
        data-tone="bad"
        onClick={showAdvice}
        title="Expected audio is silent. Show what to do."
        className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full border-2 border-white bg-accent-red px-4 text-base font-extrabold uppercase tracking-wider text-white motion-safe:animate-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <i aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-current" />
        Dead air
      </button>
    </span>
  );
}

/** The worst of a set of tones, for the one status dot: a fault, then a warning, then all well. */
function worstTone(chips: OnAirChip[]): "bad" | "warn" | "ok" {
  if (chips.some((chip) => chip.tone === "bad" || chip.tone === "live")) return "bad";
  if (chips.some((chip) => chip.tone === "warn")) return "warn";
  return "ok";
}

/**
 * Every status the strip used to show as pills (stream, engine, monitor, guests, the output reading), folded into one
 * dot. All well is a small dot and nothing else; a warning or fault names itself beside the dot, tersely. The detail
 * opens on hover, focus or a tap, and stays in the document for assistive technology either way.
 */
function DeskStatus({ chips, sample, uptime }: { chips: OnAirChip[]; sample: string | null; uptime: string | null }) {
  const [open, setOpen] = useState(false);
  const tone = worstTone(chips);
  const faults = chips.filter((chip) => chip.tone === "bad" || chip.tone === "warn" || chip.tone === "live");
  return (
    <div
      className="desk-status relative"
      data-tone={tone}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="desk-status-detail"
        aria-label={tone === "ok" ? "Status: all well. Show detail" : `Status: ${faults.map((chip) => chip.label).join(", ")}. Show detail`}
        onClick={() => setOpen((value) => !value)}
        className="desk-status-button"
      >
        <i aria-hidden="true" className="desk-dot" data-tone={tone} />
        {tone === "ok" ? null : (
          <span className="desk-status-fault">{faults.map((chip) => chip.label).join(" · ")}</span>
        )}
      </button>
      <div
        id="desk-status-detail"
        role="group"
        aria-label="Status detail"
        className={open ? "desk-status-detail" : "sr-only"}
      >
        <ul className="space-y-1.5">
          {chips.map((chip) => {
            const pill = <StatePill tone={chip.tone} label={chip.label} title={chip.title} />;
            return (
              <li key={chip.id}>
                {chip.href ? (
                  <Link
                    to={chip.href}
                    aria-label={`${chip.label}. Open ${chip.id === "guests" ? "guest calls" : "radio settings"}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {pill}
                  </Link>
                ) : (
                  pill
                )}
              </li>
            );
          })}
        </ul>
        <p className="desk-status-foot">
          Palazzo mix before Icecast · {sample ? `sample ${sample}` : "no level sample"}
          {uptime ? ` · stream up ${uptime}` : ""}
        </p>
      </div>
    </div>
  );
}

/** The song's position, filling from what has played to its length. */
function PositionBar({ elapsedMs, remainingMs, dimmed }: { elapsedMs: number; remainingMs: number; dimmed: boolean }) {
  const lengthMs = elapsedMs + remainingMs;
  const share = lengthMs > 0 ? Math.min(1, Math.max(0, elapsedMs / lengthMs)) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Song position"
      aria-valuemin={0}
      aria-valuemax={Math.round(lengthMs / 1000)}
      aria-valuenow={Math.round(elapsedMs / 1000)}
      aria-valuetext={`${formatClock(elapsedMs)} of ${formatClock(lengthMs)}`}
      data-dimmed={dimmed ? "true" : undefined}
      className="desk-position"
    >
      <span className="desk-position-fill" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

/** The wall clock, compact, in the strip. */
function DeskClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <time aria-label="Local wall clock" className="desk-clock">
      {now?.toLocaleTimeString(undefined, { hour12: false }) ?? "—"}
    </time>
  );
}

const LAMP_TONE = (view: OnAirView, fallback: boolean, ended: boolean) =>
  view.state === "on-air" || fallback || view.state === "off-rundown"
    ? "live"
    : view.state === "delayed" ||
        view.state === "unconfirmed" ||
        view.state === "unverified" ||
        view.state === "audio-unconfirmed" ||
        ended
      ? "warn"
      : "idle";

/**
 * The line that never scrolls away, laid out as a broadcast automation's on-air bar: a state lamp, the song and its
 * position, a large countdown, what plays next, one status dot and the clock, each in a fixed column so nothing moves
 * as the state changes. Props follow the OnAirStrip pinned in bleecker#549.
 */
export function OnAirStrip({
  view,
  programId,
  controls,
  sample = null,
  uptime = null,
}: {
  view: OnAirView;
  programId: string;
  controls?: ReactNode;
  /** When the output level was last sampled, for the status detail. */
  sample?: string | null;
  /** How long the stream has been up, for the status detail. */
  uptime?: string | null;
}) {
  // A song's title and clock; audio with no song commanded has neither (D7), so it gets its own line.
  const fallback = view.state === "fallback";
  const offRundown =
    view.state === "off-rundown" || view.state === "audio-unconfirmed";
  const ended = view.state === "rotation-ended";
  const on = view.state !== "off-air" && !fallback && !offRundown && !ended;
  const clock = on && !view.jingle && view.state !== "unconfirmed" && view.state !== "delayed";
  const tone = LAMP_TONE(view, fallback, ended);
  return (
    <section
      aria-label="On air"
      data-state={view.state}
      data-dead-air={view.deadAir ? "true" : undefined}
      className="desk-strip"
    >
      <div className="desk-strip-lamp">
        {view.deadAir ? (
          <DeadAirPill />
        ) : (
          <span role="status" data-tone={tone} className="desk-lamp" data-pulse={view.state === "on-air" ? "true" : undefined}>
            {view.label}
          </span>
        )}
      </div>
      <div className="desk-strip-now">
        {on ? (
          <>
            <p className="desk-title">{view.title}</p>
            <p className="desk-subtitle">
              {view.artist}
              {view.intro ? (
                <>
                  {" · "}
                  <span data-testid="intro-state">{view.intro.label}</span>
                </>
              ) : null}
            </p>
          </>
        ) : fallback ? (
          <>
            <p className="desk-title">Fallback playlist</p>
            <p className="desk-subtitle">No song commanded · {programId}</p>
          </>
        ) : offRundown ? (
          <>
            <p className="desk-title">Audio not from the rundown</p>
            <p className="desk-subtitle">No song commanded · {programId}</p>
          </>
        ) : ended ? (
          // Walk part 4: a rotation that does not loop ran out. A warning, never a silent Off air.
          <>
            <p className="desk-title">Nothing is scheduled</p>
            <p className="desk-subtitle">Rotation ended, manual now · {programId}</p>
          </>
        ) : (
          <>
            <p className="desk-title text-text-secondary">Nothing on air</p>
            <p className="desk-subtitle">{programId}</p>
          </>
        )}
        {/* The position bar keeps its row in every state, so nothing below it moves. */}
        {clock && view.elapsedMs !== null && view.remainingMs !== null ? (
          <PositionBar elapsedMs={view.elapsedMs} remainingMs={view.remainingMs} dimmed={view.state === "unverified"} />
        ) : (
          <div aria-hidden="true" className="desk-position" data-empty="true" />
        )}
      </div>
      <div
        className="desk-strip-count"
        aria-label={
          !on || view.jingle
            ? "No song clock"
            : view.remainingMs === null
              ? "Time not available"
              : `${formatClock(view.elapsedMs)} played, ${formatClock(view.remainingMs)} left`
        }
      >
        {view.state === "audio-unconfirmed" || view.state === "unconfirmed" ? (
          <span className="desk-count-note">No engine confirmation</span>
        ) : fallback || offRundown || view.jingle ? (
          <span className="desk-count-note">No song clock</span>
        ) : view.state === "delayed" ? (
          <span className="desk-count-note">No live clock</span>
        ) : on ? (
          // While the output is unverified the clock keeps its place but is dimmed (#706).
          <span
            data-testid="on-air-clock"
            data-dimmed={view.state === "unverified" ? "true" : undefined}
            className={view.state === "unverified" ? "opacity-40" : undefined}
          >
            <span className="desk-elapsed">{formatClock(view.elapsedMs)}</span>
            <strong className="desk-countdown">−{formatClock(view.remainingMs)}</strong>
          </span>
        ) : null /* No song, no countdown: the column keeps its width, empty (never an invented —:—). */}
      </div>
      <div className="desk-strip-next">
        <p className="desk-eyebrow">Next · {view.modeLabel}</p>
        {view.next ? (
          <p className="truncate">
            <span className="font-semibold">{view.next.title}</span>
            {view.next.detail ? (
              <span className="text-text-secondary"> · {view.next.detail}</span>
            ) : null}
          </p>
        ) : (
          <p className="text-text-secondary">Nothing cued</p>
        )}
      </div>
      <DeskStatus chips={view.chips} sample={sample} uptime={uptime} />
      <DeskClock />
      {controls ? <div className="desk-strip-controls">{controls}</div> : null}
    </section>
  );
}
