import { useMemo, useRef, useState } from "react";
import type {
  FlightCue,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import {
  ANCHOR_STEP_SECONDS,
  LIBRARY_DRAG_TYPE,
  dropIndex,
  parseLibraryDrag,
  snapSeconds,
  timelineLayout,
  type LibraryEntry,
} from "../utils/rundownBuilder";
import { formatRundownDuration } from "./RundownEventList";

function clockAt(scheduledAt: string, offsetMs: number): string {
  return new Date(Date.parse(scheduledAt) + offsetMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function clockWithSeconds(scheduledAt: string, offsetMs: number): string {
  return new Date(Date.parse(scheduledAt) + offsetMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function cueTitle(
  cue: FlightCue,
  songs: SongCatalogItem[],
  clips: InstantItem[],
): string {
  if (cue.kind === "playSong")
    return songs.find((song) => song.id === cue.songId)?.title ?? "Choose song";
  if (cue.kind === "instant")
    return (
      clips.find((clip) => clip.id === cue.instantId)?.name ?? "Choose clip"
    );
  return cue.label ?? "Stop program audio";
}

const percent = (ms: number, span: number) => `${(ms / span) * 100}%`;

/**
 * The block as a span of time (gaulatti/alcantara#299). Items sit where
 * rundownTiming() starts them; gold pins on the ruler are fixed starts
 * (clockOffsetSeconds) that drag, or step with ←/→, in 5 s; gaps are hatched,
 * cuts red, and an item with no stored length is dashed.
 */
export function RundownTimeline({
  items,
  songs,
  clips,
  scheduledAt,
  activeIndex,
  selectedCueId,
  disabled,
  onSelect,
  onDropEntry,
  onMoveAnchor,
}: {
  items: FlightCue[];
  songs: SongCatalogItem[];
  clips: InstantItem[];
  scheduledAt: string;
  activeIndex: number;
  selectedCueId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onDropEntry: (entry: LibraryEntry, index: number) => void;
  onMoveAnchor: (index: number, seconds: number) => void;
}) {
  const layout = useMemo(() => timelineLayout(items, songs), [items, songs]);
  const ruler = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{
    index: number;
    span: number;
  } | null>(null);
  const [dropping, setDropping] = useState(false);
  // While a pin is dragged the axis holds still, so the pin stays under the
  // pointer even when the block grows.
  const span = dragging?.span ?? layout.spanMs;
  const minutes = Math.round(span / 60_000);

  const msAt = (element: HTMLElement | null, clientX: number) => {
    const box = element?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return (
      (Math.min(Math.max(clientX - box.left, 0), box.width) / box.width) * span
    );
  };
  const movable = (index: number) =>
    !disabled && index > 0 && index > activeIndex;

  return (
    <section className="rundown-timeline" aria-label="Rundown timeline">
      <div className="rundown-timeline-head">
        <h3>
          {clockAt(scheduledAt, 0)} – {clockAt(scheduledAt, span)}
        </h3>
        <span className="rundown-timeline-total" role="status">
          Content <b>{formatRundownDuration(layout.contentMs)}</b>
          {" · "}Gaps <b>{formatRundownDuration(layout.gapMs)}</b>
          {layout.overrunMs > 0 && (
            <>
              {" · "}
              <b className="rundown-timeline-overrun">
                Overrun {formatRundownDuration(layout.overrunMs)}
              </b>
            </>
          )}
          {layout.unknownCount > 0 &&
            ` · ${layout.unknownCount} with no stored length`}
        </span>
      </div>
      <div className="rundown-ruler" ref={ruler}>
        {Array.from({ length: minutes + 1 }, (_, minute) => (
          <span
            key={minute}
            className="rundown-tick"
            data-major={minute % 5 === 0}
            style={{ left: percent(minute * 60_000, span) }}
          >
            {minute % 5 === 0 && (
              <span>{clockAt(scheduledAt, minute * 60_000)}</span>
            )}
          </span>
        ))}
        {layout.anchors.map(({ index, seconds }) => {
          const cue = items[index];
          const title = cueTitle(cue, songs, clips);
          const canMove = movable(index);
          return (
            <span
              key={cue.id}
              role="slider"
              tabIndex={canMove ? 0 : -1}
              aria-label={`Fixed start of ${title}`}
              aria-disabled={!canMove}
              aria-valuemin={0}
              aria-valuemax={Math.round(span / 1000)}
              aria-valuenow={seconds}
              aria-valuetext={clockWithSeconds(scheduledAt, seconds * 1000)}
              className="rundown-pin"
              data-dragging={dragging?.index === index}
              style={{ left: percent(seconds * 1000, span) }}
              onKeyDown={(event) => {
                if (!canMove) return;
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const step =
                  (event.shiftKey ? 12 : 1) *
                  ANCHOR_STEP_SECONDS *
                  (event.key === "ArrowLeft" ? -1 : 1);
                onMoveAnchor(index, snapSeconds(seconds + step));
              }}
              onPointerDown={(event) => {
                if (!canMove) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setDragging({ index, span: layout.spanMs });
              }}
              onPointerMove={(event) => {
                if (dragging?.index !== index) return;
                onMoveAnchor(
                  index,
                  snapSeconds(msAt(ruler.current, event.clientX) / 1000),
                );
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
            />
          );
        })}
      </div>
      <div
        className="rundown-lane"
        ref={lane}
        data-dropping={dropping}
        aria-label="Timeline items"
        role="group"
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE))
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          const entry = parseLibraryDrag(
            event.dataTransfer.getData(LIBRARY_DRAG_TYPE),
          );
          if (disabled || !entry) return;
          event.preventDefault();
          onDropEntry(
            entry,
            dropIndex(layout, msAt(lane.current, event.clientX)),
          );
        }}
      >
        {layout.zones.map((zone) => (
          <span
            key={`${zone.kind}-${items[zone.index].id}`}
            className="rundown-zone"
            data-kind={zone.kind}
            style={{
              left: percent(zone.leftMs, span),
              width: percent(zone.widthMs, span),
            }}
            title={
              zone.kind === "gap"
                ? `${formatRundownDuration(zone.widthMs)} gap, filled by the continuous fillers`
                : `${formatRundownDuration(zone.widthMs)} cut at the next fixed start`
            }
          >
            {zone.kind === "gap" ? "Gap" : "Cut"}{" "}
            {formatRundownDuration(zone.widthMs)}
          </span>
        ))}
        {layout.items.map((item) => {
          const title = cueTitle(item.cue, songs, clips);
          return (
            <button
              key={item.cue.id}
              type="button"
              className="rundown-item"
              data-kind={item.cue.kind}
              data-filler={!!item.cue.isFiller}
              data-unknown={item.unknown}
              data-locked={item.index <= activeIndex}
              aria-pressed={selectedCueId === item.cue.id}
              aria-label={`${title}, ${
                item.startMs === null
                  ? "start unknown"
                  : `starts ${clockWithSeconds(scheduledAt, item.startMs)}`
              }, ${
                item.unknown
                  ? "no stored length"
                  : formatRundownDuration(item.durationMs)
              }`}
              style={{
                left: percent(item.leftMs, span),
                width: percent(item.widthMs, span),
              }}
              onClick={() => onSelect(item.cue.id)}
            >
              <b>{title}</b>
              <small>
                {item.unknown ? "—" : formatRundownDuration(item.durationMs)}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
