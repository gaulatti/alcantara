import { ConsoleClock } from "../ConsoleSurface";
import { deriveOnAir, formatClock, type OnAirInput, type OnAirView } from "./onAir";
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
}: {
  input: Omit<OnAirInput, "outputUnverified">;
  output: { state: string; lastSampleAt: string | null } | null;
  programId: string;
  guests?: DeskGuest[];
}) {
  const outputUnverified = useOutputUnverified(output);
  const view = deriveOnAir({ ...input, outputUnverified });
  const call = guestChip(guests);
  return <OnAirStrip view={call ? { ...view, chips: [call, ...view.chips] } : view} programId={programId} />;
}

/**
 * The line that never scrolls away: whether the program is on air, what plays, how long is left,
 * what comes next, and whether the listener hears it. Props follow the OnAirStrip pinned in
 * bleecker#549.
 */
export function OnAirStrip({
  view,
  programId,
}: {
  view: OnAirView;
  programId: string;
}) {
  // A song's title and clock; audio with no song commanded has neither (D7), so it gets its own line.
  const fallback = view.state === "fallback";
  const offRundown =
    view.state === "off-rundown" || view.state === "audio-unconfirmed";
  const ended = view.state === "rotation-ended";
  const on = view.state !== "off-air" && !fallback && !offRundown && !ended;
  return (
    <section
      aria-label="On air"
      data-state={view.state}
      className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sand/30 bg-deep-sea px-3 py-1.5 text-text-primary md:gap-x-5 md:gap-y-2 md:px-4 md:py-2.5"
    >
      <StatePill
        tone={
          view.state === "on-air" || fallback || view.state === "off-rundown"
            ? "live"
            : view.state === "delayed" ||
                view.state === "unconfirmed" ||
                view.state === "unverified" ||
                view.state === "audio-unconfirmed" ||
                ended
              ? "warn"
              : "idle"
        }
        label={view.label}
        pulse={view.state === "on-air"}
        live
      />
      <div className="min-w-0 flex-1 basis-40 md:basis-64">
        {on ? (
          <>
            <p className="truncate text-sm font-semibold">{view.title}</p>
            <p className="truncate text-xs text-text-secondary">
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
            <p className="truncate text-sm font-semibold">Fallback playlist</p>
            <p className="truncate text-xs text-text-secondary">
              Palazzo's local playlist, no song commanded · {programId}
            </p>
          </>
        ) : offRundown ? (
          <>
            <p className="truncate text-sm font-semibold">
              Audio not from the rundown
            </p>
            <p className="truncate text-xs text-text-secondary">
              No song commanded · {programId}
            </p>
          </>
        ) : ended ? (
          // Walk part 4: a rotation that does not loop ran out. A warning, never a silent Off air.
          <>
            <p className="truncate text-sm font-semibold">Nothing is scheduled</p>
            <p className="truncate text-xs text-text-secondary">
              The rotation does not loop and is manual now · {programId}
            </p>
          </>
        ) : (
          <p className="text-sm text-text-secondary">
            Nothing on air · {programId}
          </p>
        )}
      </div>
      {view.state === "audio-unconfirmed" ? (
        <span className="text-xs text-amber-200">No engine confirmation</span>
      ) : fallback || offRundown ? (
        <span className="text-xs text-text-secondary">No song clock</span>
      ) : null}
      {on ? (
        <div
          className="font-mono tabular-nums"
          aria-label={
            view.remainingMs === null
              ? "Time not available"
              : `${formatClock(view.elapsedMs)} played, ${formatClock(view.remainingMs)} left`
          }
        >
          {view.state === "unconfirmed" ? (
            <span className="text-xs text-amber-200">No engine confirmation</span>
          ) : view.state === "delayed" ? (
            <span className="text-xs text-amber-200">No live clock</span>
          ) : (
            // While the output is unverified the clock keeps its place but is dimmed (#706).
            <span
              data-testid="on-air-clock"
              data-dimmed={view.state === "unverified" ? "true" : undefined}
              className={view.state === "unverified" ? "opacity-40" : undefined}
            >
              <span className="text-xs text-text-secondary">
                {formatClock(view.elapsedMs)}
              </span>{" "}
              <strong className="text-lg">
                −{formatClock(view.remainingMs)}
              </strong>
            </span>
          )}
        </div>
      ) : null}
      <div className="min-w-0 flex-1 basis-40 text-xs md:flex-none md:basis-56">
        <p className="text-text-secondary">Next · {view.modeLabel}</p>
        {view.next ? (
          <p className="truncate">
            <span className="font-semibold">{view.next.title}</span>
            {view.next.detail ? (
              <span className="text-text-secondary">
                {" "}
                · {view.next.detail}
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-text-secondary">Nothing cued</p>
        )}
      </div>
      {/* On a phone the chips share one line with the clock and scroll sideways (#610); wider screens wrap them. */}
      <div className="flex min-w-0 flex-1 basis-40 flex-nowrap items-center gap-1.5 overflow-x-auto md:flex-none md:basis-auto md:flex-wrap md:overflow-visible [&>*]:shrink-0">
        {view.chips.map((chip) => {
          const pill = <StatePill key={chip.id} tone={chip.tone} label={chip.label} title={chip.title} />;
          return chip.href ? (
            <Link key={chip.id} to={chip.href} aria-label={`${chip.label}. Open ${chip.id === "guests" ? "guest calls" : "radio settings"}`} className="underline-offset-2 hover:underline">
              {pill}
            </Link>
          ) : (
            pill
          );
        })}
      </div>
      <ConsoleClock />
    </section>
  );
}
