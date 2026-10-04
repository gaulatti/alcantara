import { Clock3, Mic2, LockKeyhole } from "lucide-react";
import type {
  FlightCue,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import { rundownTiming } from "../utils/rundownTiming";
import "./Rundown.css";

export function formatRundownDuration(milliseconds: number | null | undefined) {
  if (milliseconds == null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function RundownEventList({
  items,
  songs,
  clips,
  scheduledAt,
  selectedCueId,
  activeIndex,
  onSelect,
}: {
  items: FlightCue[];
  songs: SongCatalogItem[];
  clips: InstantItem[];
  scheduledAt: string;
  selectedCueId: string | null;
  activeIndex: number;
  onSelect: (id: string) => void;
}) {
  const timing = rundownTiming(items, songs);
  return (
    <div className="rundown-log-scroll">
      <table className="rundown-log" aria-label="Scheduled rundown events">
        <thead>
          <tr>
            <th scope="col">Start</th>
            <th scope="col" className="rundown-kind-column">
              Type
            </th>
            <th scope="col">Event</th>
            <th scope="col">Length</th>
            <th scope="col" className="rundown-status-column">
              Timing
            </th>
          </tr>
        </thead>
        <tbody>
          {items
            .map((cue, index) => {
              const song = songs.find((song) => song.id === cue.songId);
              const clip = clips.find((clip) => clip.id === cue.instantId);
              const title =
                cue.kind === "playSong"
                  ? (song?.title ?? "Choose song")
                  : cue.kind === "instant"
                    ? (clip?.name ?? "Choose clip")
                    : (cue.label ?? "Stop program audio");
              const type =
                cue.kind === "playSong"
                  ? cue.isFiller
                    ? "Filler"
                    : "Music"
                  : cue.kind === "instant"
                    ? "Clip"
                    : "Stop";
              const row = timing[index];
              const clock =
                row.startMs === null
                  ? "—"
                  : new Date(
                      Date.parse(scheduledAt) + row.startMs,
                    ).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    });
              const locked = index <= activeIndex;
              return (
                <tr
                  key={cue.id}
                  data-selected={selectedCueId === cue.id}
                  data-fixed={cue.clockOffsetSeconds !== undefined}
                  data-active={index === activeIndex}
                >
                  <td className="rundown-clock">
                    <span>{clock}</span>
                    {cue.clockOffsetSeconds !== undefined ? (
                      <span className="rundown-fixed">
                        <Clock3 size={10} /> Fixed
                      </span>
                    ) : (
                      <span className="rundown-follows">Est.</span>
                    )}
                  </td>
                  <td className="rundown-kind-column">
                    <span className="rundown-event-kind" data-kind={type}>
                      {type}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="rundown-event-select"
                      aria-pressed={selectedCueId === cue.id}
                      onClick={() => onSelect(cue.id)}
                    >
                      <span className="rundown-event-title">
                        {locked && <LockKeyhole size={11} />} {title}{" "}
                        {cue.voiceTrackInstantId && <Mic2 size={12} />}
                      </span>
                      <span className="rundown-event-detail">
                        {song?.artist ??
                          (cue.kind === "instant"
                            ? "Standalone audio"
                            : "Intentional silence")}
                        {cue.isFiller && cue.kind === "playSong"
                          ? " · Filler"
                          : ""}
                      </span>
                      {!!row.cutMs && (
                        <span className="rundown-event-warning">
                          {formatRundownDuration(row.cutMs)}{" "}
                          {cue.isFiller
                            ? "cut at fixed start"
                            : "content overrun"}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="rundown-duration">
                    {formatRundownDuration(row.durationMs)}
                  </td>
                  <td className="rundown-status-column">
                    {row.durationMs == null ? (
                      <span className="rundown-event-warning">Unknown</span>
                    ) : row.cutMs ? (
                      <span className="rundown-event-warning">
                        {cue.isFiller ? "Cut" : "Overrun"}
                      </span>
                    ) : (
                      <span className="rundown-follows">
                        {locked ? "Locked" : "Fits"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })
            .flatMap((row, index) => {
              const gap = timing[index].gapMs;
              return gap
                ? [
                    row,
                    <tr key={`${items[index].id}-gap`} className="rundown-gap">
                      <td className="rundown-clock">—</td>
                      <td className="rundown-kind-column">Gap</td>
                      <td>
                        {items[index].kind === "stopSong"
                          ? "Intentional silence"
                          : "Unfilled time · preview fillers"}
                      </td>
                      <td className="rundown-duration">
                        {formatRundownDuration(gap)}
                      </td>
                      <td className="rundown-status-column">
                        {items[index].kind === "stopSong" ? "Silence" : "Gap"}
                      </td>
                    </tr>,
                  ]
                : [row];
            })}
        </tbody>
      </table>
      {!items.length && (
        <div className="rundown-empty">
          <strong>Build this hour</strong>
          <p>
            Add content at its fixed times, then fill the gaps from a Library
            tag.
          </p>
        </div>
      )}
    </div>
  );
}
