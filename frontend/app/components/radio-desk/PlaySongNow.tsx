import { Input } from "@gaulatti/bleecker";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SongCatalogItem } from "../../models/broadcast";
import { formatClock } from "./onAir";
import { KeyCap } from "./primitives";
import { findPlayableSongs, type PlayCandidate, type SongLeaf } from "./songs";
import { useArmed } from "./useArmed";

/**
 * Search the rotation and the library from the desk (press /), then queue a song next or take it
 * now. Taking now is arm-then-confirm: the first press arms the row, and Confirm within the arm
 * time puts it on air. A library song that is not in the rotation cannot be queued, only taken.
 */
export function PlaySongNow({
  open,
  leaves,
  catalog,
  onClose,
  onCueNext,
  onTakeNow,
}: {
  open: boolean;
  leaves: SongLeaf[];
  catalog: SongCatalogItem[];
  onClose: () => void;
  /** Queues a rotation song to play next. */
  onCueNext: (leaf: SongLeaf) => Promise<void> | void;
  /** Puts a song on air now. */
  onTakeNow: (candidate: PlayCandidate) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { armed, arm, take, disarm } = useArmed<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => findPlayableSongs(leaves, catalog, query),
    [leaves, catalog, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setMessage(null);
    setError(null);
    disarm();
    inputRef.current?.focus();
  }, [open, disarm]);

  useEffect(() => {
    setSelected(0);
    disarm();
  }, [query, disarm]);

  if (!open) return null;

  const run = async (action: () => Promise<void> | void, done: string) => {
    setError(null);
    try {
      await action();
      setMessage(done);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The song was not played");
    }
  };

  // The caller holds the leaf it checked, so no guard is needed here.
  const cueNext = (candidate: PlayCandidate, leaf: SongLeaf) => {
    void run(() => onCueNext(leaf), `${candidate.title} queued next`);
  };

  const takeNow = (candidate: PlayCandidate) => {
    if (armed !== candidate.key) {
      arm(candidate.key);
      setMessage(null);
      return;
    }
    take();
    void run(() => onTakeNow(candidate), `${candidate.title} is on air`);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (armed) disarm();
      else onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const candidate = results[selected];
      if (!candidate) return;
      if (event.shiftKey || !candidate.leaf) takeNow(candidate);
      else cueNext(candidate, candidate.leaf);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Play a song now"
      onKeyDown={onKeyDown}
      className="fixed inset-x-0 top-24 z-40 mx-auto w-[min(40rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border border-sand/40 bg-deep-sea p-3 shadow-2xl"
    >
      <Input
        ref={inputRef}
        aria-label="Search the rotation and the library"
        placeholder="Search the rotation and the library…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul role="listbox" aria-label="Songs" className="mt-2 max-h-72 overflow-auto">
        {results.map((candidate, index) => {
          const isArmed = armed === candidate.key;
          const leaf = candidate.leaf;
          return (
            <li
              key={candidate.key}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              className={`flex items-center gap-3 rounded-[7px] px-2 py-1.5 text-sm ${index === selected ? "bg-accent-blue/10" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{candidate.title}</span>
                <span className="block truncate text-xs text-text-secondary">
                  {candidate.artist} ·{" "}
                  {candidate.source === "rotation" ? "Rotation" : "Library"}
                  {candidate.durationMs
                    ? ` · ${formatClock(candidate.durationMs)}`
                    : ""}
                </span>
              </span>
              {leaf ? (
                <button
                  type="button"
                  aria-label={`Cue next ${candidate.title}`}
                  onClick={() => cueNext(candidate, leaf)}
                  className="h-7 rounded-[6px] border border-sand/50 px-2 text-xs font-semibold"
                >
                  Cue next
                </button>
              ) : (
                <span className="text-[11px] text-text-secondary">
                  Not in the rotation
                </span>
              )}
              <button
                type="button"
                aria-label={`${isArmed ? "Confirm" : "Take now"} ${candidate.title}`}
                onClick={() => takeNow(candidate)}
                className={`h-7 rounded-[6px] border px-2 text-xs font-semibold ${isArmed ? "border-accent-red bg-accent-red text-white" : "border-accent-yellow text-accent-yellow"}`}
              >
                {isArmed ? "Confirm" : "Take now"}
              </button>
            </li>
          );
        })}
        {query.trim() && results.length === 0 ? (
          <li className="px-2 py-3 text-sm text-text-secondary">
            No song matches “{query.trim()}”.
          </li>
        ) : null}
      </ul>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
        <KeyCap keys={["↑", "↓"]} /> select <KeyCap>Enter</KeyCap> cue next{" "}
        <KeyCap keys={["Shift", "Enter"]} /> take now (then confirm within 5 s){" "}
        <KeyCap>Esc</KeyCap> close
        {/* A touch screen has no Escape. */}
        <button type="button" onClick={onClose} className="ml-auto h-7 rounded-[6px] border border-sand/50 px-2 text-xs font-semibold">
          Close
        </button>
      </p>
      {armed ? (
        <p role="status" className="mt-1 text-xs text-accent-yellow">
          Armed. Confirm within 5 seconds to put it on air.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-1 text-xs text-emerald-300">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-terracotta">
          {error}
        </p>
      ) : null}
    </div>
  );
}
