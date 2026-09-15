import { useMemo, useState } from "react";
import { Button } from "@gaulatti/bleecker";
import { ArrowDown, ArrowUp, ListMusic, Trash2 } from "lucide-react";
import type { ProgramSongQueueEntry } from "../models/broadcast";
import type {
  ProgramSongSequence,
  ProgramSongSequenceItem,
} from "../utils/programSequence";

type SongLeaf = Extract<ProgramSongSequenceItem, { kind: "preset" }>;

function collectSongLeaves(
  items: ProgramSongSequenceItem[],
  byId: Map<string, SongLeaf | null>,
): void {
  for (const item of items) {
    if (item.kind === "sequence") {
      collectSongLeaves(item.sequence.items, byId);
      continue;
    }
    byId.set(item.id, byId.has(item.id) ? null : item);
  }
}

interface PlayNextQueueProps {
  queue: ProgramSongQueueEntry[];
  sequence: ProgramSongSequence;
  activeQueueEntryId?: string | null;
  onRemove: (entryId: string) => Promise<void> | void;
  onReorder: (entryIds: string[]) => Promise<void> | void;
}

export function PlayNextQueue({
  queue,
  sequence,
  activeQueueEntryId,
  onRemove,
  onReorder,
}: PlayNextQueueProps) {
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const songsById = useMemo(() => {
    const result = new Map<string, SongLeaf | null>();
    collectSongLeaves(sequence.items, result);
    return result;
  }, [sequence.items]);
  const activeIndex = activeQueueEntryId
    ? queue.findIndex((entry) => entry.id === activeQueueEntryId)
    : -1;

  const run = async (entryId: string, action: () => Promise<void> | void) => {
    setPendingEntryId(entryId);
    setError(null);
    try {
      await action();
    } catch {
      setError("The Play Next queue was not changed. Try again.");
    } finally {
      setPendingEntryId(null);
    }
  };

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= queue.length) return;
    const reordered = [...queue];
    const [entry] = reordered.splice(index, 1);
    reordered.splice(target, 0, entry);
    void run(entry.id, () => onReorder(reordered.map((item) => item.id)));
  };

  return (
    <section
      aria-label="Play Next queue"
      className="border-b border-sand/30 bg-dark-sand/70"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <ListMusic size={14} className="text-sea" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-primary">
            Play Next
          </span>
        </div>
        <span className="rounded-full bg-sea/15 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-sea">
          {queue.length}
        </span>
      </div>
      {queue.length === 0 ? (
        <p className="border-t border-sand/20 px-3 py-2 text-[11px] text-text-secondary">
          Use the Play Next action on any playlist song.
        </p>
      ) : (
        <ol className="max-h-48 divide-y divide-sand/20 overflow-y-auto border-t border-sand/20">
          {queue.map((entry, index) => {
            const song = songsById.get(entry.itemId) ?? null;
            const isPlaying = entry.id === activeQueueEntryId;
            const disabled = pendingEntryId !== null;
            return (
              <li
                key={entry.id}
                className={`grid grid-cols-[24px_1fr_84px] items-center gap-2 px-3 py-2 ${isPlaying ? "bg-sea/15" : ""}`}
              >
                <span className="text-center text-[11px] font-semibold tabular-nums text-text-secondary">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-text-primary">
                      {song?.title || "Unavailable playlist item"}
                    </span>
                    {isPlaying ? (
                      <span className="shrink-0 rounded bg-sea/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sea">
                        Playing
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate text-[10px] text-text-secondary">
                    {song?.artist ||
                      "Remove this entry before playback can continue"}
                  </p>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    type="button"
                    disabled={
                      disabled ||
                      isPlaying ||
                      index === 0 ||
                      index === activeIndex + 1
                    }
                    onClick={() => move(index, -1)}
                    className="flex h-6 w-6 items-center justify-center border-0 bg-transparent p-0 text-text-secondary shadow-none hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30"
                    title="Move earlier"
                    aria-label={`Move ${song?.title || "queued song"} earlier`}
                  >
                    <ArrowUp size={12} />
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      disabled ||
                      isPlaying ||
                      index === activeIndex - 1 ||
                      index === queue.length - 1
                    }
                    onClick={() => move(index, 1)}
                    className="flex h-6 w-6 items-center justify-center border-0 bg-transparent p-0 text-text-secondary shadow-none hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30"
                    title="Move later"
                    aria-label={`Move ${song?.title || "queued song"} later`}
                  >
                    <ArrowDown size={12} />
                  </Button>
                  <Button
                    type="button"
                    disabled={disabled || isPlaying}
                    onClick={() => void run(entry.id, () => onRemove(entry.id))}
                    className="flex h-6 w-6 items-center justify-center border-0 bg-transparent p-0 text-text-secondary shadow-none hover:translate-y-0 hover:scale-100 hover:text-terracotta disabled:opacity-30"
                    title={isPlaying ? "Playing now" : "Remove from Play Next"}
                    aria-label={`Remove ${song?.title || "queued song"} from Play Next`}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {error ? (
        <p
          role="alert"
          className="border-t border-red-400/20 px-3 py-2 text-[11px] text-red-300"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
