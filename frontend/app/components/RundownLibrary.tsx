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
 * the timeline, or select it and press Enter to add it at the end. With
 * `recipes` (gaulatti/alcantara#425), a Recipes tab adds a song through the
 * chosen recipe: the bumper, the song, its slideshow and back, as one use.
 */
export function RundownLibrary({
  songs,
  clips,
  disabled,
  onAdd,
  recipes,
  onAddRecipe,
  footnote = "Drag onto the timeline, or select and press Enter to add at the end.",
}: {
  songs: SongCatalogItem[];
  clips: InstantItem[];
  disabled: boolean;
  onAdd: (entry: LibraryEntry) => void;
  /** The program's recipes; a Recipes tab appears when there is at least one. */
  recipes?: { id: number; name: string }[] | null;
  onAddRecipe?: (recipeId: number, songId: number) => void;
  footnote?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "song" | "clip" | "recipe">("all");
  const [active, setActive] = useState(0);
  const [recipeId, setRecipeId] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const hasRecipes = Boolean(recipes?.length && onAddRecipe);
  const recipeMode = hasRecipes && filter === "recipe";
  const chosenRecipe =
    recipes?.find((recipe) => recipe.id === recipeId) ?? recipes?.[0] ?? null;
  const rows = useMemo(
    () =>
      recipeMode
        ? libraryRows(songs, [], query, "song")
        : libraryRows(songs, clips, query, filter === "recipe" ? "all" : filter),
    [songs, clips, query, filter, recipeMode],
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
    if (!entry || disabled) return;
    if (recipeMode) {
      if (entry.type === "song" && chosenRecipe)
        onAddRecipe?.(chosenRecipe.id, entry.id);
      return;
    }
    onAdd(entry);
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
        {[...FILTERS, ...(hasRecipes ? ([["recipe", "Recipes"]] as const) : [])].map(
          ([id, label]) => (
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
          ),
        )}
      </div>
      {recipeMode && recipes ? (
        <label className="rundown-library-recipe">
          <span>Recipe</span>
          <select
            aria-label="Recipe"
            value={chosenRecipe?.id ?? ""}
            onChange={(event) => setRecipeId(Number(event.target.value))}
          >
            {recipes.map((recipe) => (
              <option key={recipe.id} value={recipe.id}>
                {recipe.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
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
            draggable={!disabled && !recipeMode}
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
        {recipeMode
          ? `Select a song and press Enter to add it with ${chosenRecipe?.name ?? "the recipe"}.`
          : footnote}
      </p>
    </section>
  );
}
