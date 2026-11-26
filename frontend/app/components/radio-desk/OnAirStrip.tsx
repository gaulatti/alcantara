import { ConsoleClock } from "../ConsoleSurface";
import { formatClock, type OnAirView } from "./onAir";
import { StatePill } from "./primitives";

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
  const on = view.state !== "off-air";
  return (
    <section
      aria-label="On air"
      data-state={view.state}
      className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-sand/30 bg-deep-sea px-4 py-2.5 text-text-primary"
    >
      <StatePill
        tone={
          view.state === "on-air"
            ? "live"
            : view.state === "delayed" ||
                view.state === "unconfirmed" ||
                view.state === "unverified"
              ? "warn"
              : "idle"
        }
        label={view.label}
        pulse={view.state === "on-air"}
        live
      />
      <div className="min-w-0 flex-1 basis-64">
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
        ) : (
          <p className="text-sm text-text-secondary">
            Nothing on air · {programId}
          </p>
        )}
      </div>
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
      <div className="min-w-0 basis-56 text-xs">
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
      {/* On a phone the chips share one row that scrolls sideways (#610); wider screens wrap them. */}
      <div className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto md:w-auto md:flex-wrap md:overflow-visible [&>*]:shrink-0">
        {view.chips.map((chip) => (
          <StatePill
            key={chip.id}
            tone={chip.tone}
            label={chip.label}
            title={chip.title}
          />
        ))}
      </div>
      <ConsoleClock />
    </section>
  );
}
