import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { formatLength } from "../../utils/songCatalog";

export interface TransportCue {
  /** Where the cue sits, in seconds. */
  at: number;
  label: string;
}

const SEEK_STEP_SECONDS = 5;

/**
 * One shared transport for a list of audio: previous, play or pause, next, what is loaded, a
 * timeline with cue marks and the time. Its props are the Transport pinned in bleecker#549 (and
 * built in bleecker#551), so it can be swapped for Bleecker's. The page owns the audio element.
 */
export function Transport({
  title,
  subtitle,
  position,
  duration,
  playing,
  cues = [],
  disabled = false,
  onToggle,
  onSeek,
  onPrev,
  onNext,
}: {
  title: string;
  subtitle?: string;
  position: number;
  duration: number | null;
  playing: boolean;
  cues?: TransportCue[];
  disabled?: boolean;
  onToggle: () => void;
  onSeek?: (seconds: number) => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const length = duration !== null && duration > 0 ? duration : null;
  const clamped =
    length === null
      ? Math.max(0, position)
      : Math.min(Math.max(0, position), length);
  const percent = (seconds: number, total: number) => Math.max(0, Math.min(100, (seconds / total) * 100));
  const seekTo = (seconds: number) => {
    if (onSeek && length !== null)
      onSeek(Math.max(0, Math.min(length, seconds)));
  };
  const button =
    "inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-sand/20 hover:text-text-primary disabled:pointer-events-none disabled:opacity-40";
  return (
    <div
      role="group"
      aria-label="Preview transport"
      className="flex flex-wrap items-center gap-4 border-t border-sand/25 bg-dark-sand/60 px-4 py-2.5"
    >
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous" className={button} disabled={disabled || !onPrev} onClick={onPrev}>
          <SkipBack size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          disabled={disabled}
          onClick={onToggle}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sea text-white disabled:opacity-40"
        >
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button type="button" aria-label="Next" className={button} disabled={disabled || !onNext} onClick={onNext}>
          <SkipForward size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="min-w-0 basis-48">
        <p className="truncate text-sm font-semibold text-text-primary">{title}</p>
        {subtitle ? <p className="truncate text-[11px] text-text-secondary">{subtitle}</p> : null}
      </div>
      {length !== null ? (
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(clamped)}
          aria-valuetext={`${formatLength(clamped)} of ${formatLength(length)}`}
          onKeyDown={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              onToggle();
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              seekTo(clamped + SEEK_STEP_SECONDS);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              seekTo(clamped - SEEK_STEP_SECONDS);
            }
          }}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            if (!disabled && box.width > 0)
              seekTo(((event.clientX - box.left) / box.width) * length);
          }}
          className="relative h-4 min-w-24 flex-1 cursor-pointer"
        >
          <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-sand/40" />
          <span data-testid="transport-done" className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-sea" style={{ width: `${percent(clamped, length)}%` }} />
          {cues.map((cue) => (
            <span key={`${cue.label}-${cue.at}`} title={cue.label} className="absolute top-0 h-full w-0.5 bg-accent-yellow" style={{ left: `${percent(cue.at, length)}%` }} />
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <p className="shrink-0 font-mono text-xs tabular-nums text-text-secondary">
        <b className="text-text-primary">{formatLength(clamped)}</b> / {formatLength(length)}
      </p>
    </div>
  );
}
