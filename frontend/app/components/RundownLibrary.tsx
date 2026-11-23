import { useEffect, useMemo, useRef, useState } from "react";
import type { InstantItem, SongCatalogItem } from "../models/broadcast";
import {
  LIBRARY_DRAG_TYPE,
  libraryRows,
  type LibraryEntry,
} from "../utils/rundownBuilder";
import { formatRundownDuration } from "./RundownEventList";

const FILTERS = [
  ["all", "All"],
  ["song", "Songs"],
  ["clip", "Clips"],
] as const;

/**
 * The rundown's searchable library (gaulatti/alcantara#299). Drag a row onto
 * the timeline, or select it and press Enter to add it at the end. Recipes
 * appear here once #222's model exists; until then there is no Recipes tab.
 */
export function RundownLibrary({
  songs,
  clips,
  disabled,
  onAdd,
}: {
  songs: SongCatalogItem[];
  clips: InstantItem[];
  disabled: boolean;
  onAdd: (entry: LibraryEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "song" | "clip">("all");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const rows = useMemo(
    () => libraryRows(songs, clips, query, filter),
    [songs, clips, query, filter],
  );
  const current = rows[Math.min(active, rows.length - 1)];

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        (target instanceof Element &&
          target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const add = (entry: LibraryEntry | undefined) => {
    if (entry && !disabled) onAdd(entry);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) =>
        Math.min(Math.max(index + step, 0), Math.max(rows.length - 1, 0)),
      );
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      add(current?.entry);
    }
  };

  return (
    <section className="rundown-library" aria-label="Rundown library">
      <label className="rundown-library-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={search}
          type="search"
          aria-label="Search the library"
          placeholder="Search songs and clips"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd>/</kbd>
      </label>
      <div
        className="rundown-library-tabs"
        role="group"
        aria-label="Library filter"
      >
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => {
              setFilter(id);
              setActive(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ul
        className="rundown-library-list"
        role="listbox"
        aria-label="Library items"
        aria-disabled={disabled}
        tabIndex={0}
        aria-activedescendant={current ? `library-${current.key}` : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => (
          <li
            key={row.key}
            id={`library-${row.key}`}
            role="option"
            aria-selected={row === current}
            data-group={row.group}
            draggable={!disabled}
            onClick={() => setActive(index)}
            onDoubleClick={() => add(row.entry)}
            onDragStart={(event) => {
              event.dataTransfer.setData(
                LIBRARY_DRAG_TYPE,
                JSON.stringify(row.entry),
              );
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            <span className="rundown-library-title">{row.title}</span>
            <span className="rundown-library-detail">{row.detail}</span>
            <span className="rundown-library-length">
              {row.group === "stop"
                ? "Stop"
                : row.durationMs == null
                  ? "No length"
                  : formatRundownDuration(row.durationMs)}
            </span>
          </li>
        ))}
        {!rows.length && (
          <li className="rundown-library-none" role="presentation">
            Nothing matches “{query}”.
          </li>
        )}
      </ul>
      <p className="rundown-library-foot">
        Drag onto the timeline, or select and press Enter to add at the end.
      </p>
    </section>
  );
}
