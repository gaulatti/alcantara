import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Card, Input, LoadingSpinner, Select } from "@gaulatti/bleecker";
import { Plus, Save } from "lucide-react";
import { AppPage } from "../components/AppPage";
import { ClockEditor } from "../components/ClockEditor";
import { DaypartGrid } from "../components/DaypartGrid";
import {
  createRadioClock,
  deleteRadioClock,
  fetchRadioClocks,
  fetchRadioDayparts,
  saveRadioDayparts,
  updateRadioClock,
  type RadioClock,
  type RadioDaypartGrid,
} from "../services/dayparts";
import { fetchFlightSequences } from "../services/flight";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import type { FlightSequence } from "../models/broadcast";
import { cellsOf, daypartsFrom, type DaypartCells } from "../utils/daypartCells";
import { useGlobalProgramId } from "../utils/globalProgram";

export function meta() {
  return [{ title: "Dayparts - Alcantara" }];
}

const COLORS = [
  "bg-sea/70",
  "bg-terracotta/70",
  "bg-accent-yellow/70",
  "bg-accent-blue/70",
  "bg-sand/70",
  "bg-emerald-500/70",
  "bg-sea/35",
  "bg-terracotta/35",
];
const ERASE = "";
const REFRESH_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Dayparts unavailable";

/** The next two blocks made from clocks, and any hour of the last day onward that was skipped or failed. */
export function daypartBlocks(sequences: FlightSequence[], now: number) {
  const made = sequences
    .flatMap((sequence) =>
      sequence.daypart && sequence.scheduledAt
        ? [{ sequence, at: Date.parse(sequence.scheduledAt) }]
        : [],
    )
    .sort((a, b) => a.at - b.at);
  const next = made.filter(({ at }) => at > now).slice(0, 2);
  const trouble = made.filter(
    (entry) =>
      entry.sequence.daypart!.outcome &&
      entry.at > now - DAY_MS &&
      !next.includes(entry),
  );
  return [...trouble, ...next].map(({ sequence }) => sequence);
}

export default function DaypartsPage() {
  const [programId] = useGlobalProgramId();
  return <Dayparts key={programId} programId={programId} />;
}

function Dayparts({ programId }: { programId: string }) {
  const [clocks, setClocks] = useState<RadioClock[]>([]);
  const [grid, setGrid] = useState<RadioDaypartGrid | null>(null);
  const [cells, setCells] = useState<DaypartCells>({});
  const [timeZone, setTimeZone] = useState("");
  const [labels, setLabels] = useState<{ id: string; name: string }[]>([]);
  const [sequences, setSequences] = useState<FlightSequence[]>([]);
  const [brush, setBrush] = useState(ERASE);
  const [start, setStart] = useState<"soft" | "hard">("soft");
  /** The clock being edited: its id, "new", or none. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((saved: RadioDaypartGrid) => {
    setGrid(saved);
    setCells(cellsOf(saved.dayparts));
    setTimeZone(
      saved.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      fetchRadioClocks(programId),
      fetchRadioDayparts(programId),
      fetchAllMediaLabels(),
    ])
      .then(([loadedClocks, loadedGrid, loadedLabels]) => {
        if (!mounted) return;
        setClocks(loadedClocks);
        setLabels(loadedLabels);
        show(loadedGrid);
      })
      .catch((cause) => {
        if (mounted) setError(message(cause));
      });
    const blocks = () =>
      void fetchFlightSequences(programId)
        .then((loaded) => {
          if (mounted) setSequences(loaded);
        })
        .catch(() => undefined);
    blocks();
    const timer = setInterval(blocks, REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [programId, show]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const colorOf = (clockId: number) =>
    COLORS[clocks.findIndex((clock) => clock.id === clockId) % COLORS.length] ??
    COLORS[0];

  const paint = (key: string) =>
    setCells((current) => {
      const painted = { ...current };
      if (brush === ERASE) delete painted[key];
      else painted[key] = { clockId: Number(brush), start };
      return painted;
    });

  const changed =
    !!grid &&
    (JSON.stringify(daypartsFrom(cells)) !==
      JSON.stringify(daypartsFrom(cellsOf(grid.dayparts))) ||
      (grid.timeZone !== null && timeZone !== grid.timeZone));

  const edited = clocks.find((clock) => clock.id === editing) ?? null;
  const blocks = daypartBlocks(sequences, Date.now());

  return (
    <AppPage width="full">
      <h1 className="mb-4 text-2xl font-bold">Dayparts</h1>
      {error && (
        <p role="alert" className="mb-3 text-sm text-terracotta">
          {error}
        </p>
      )}
      {!grid ? (
        !error && <LoadingSpinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <div className="min-w-48 text-xs">
                Paint with
                <Select
                  aria-label="Paint with"
                  value={brush}
                  onChange={setBrush}
                  options={[
                    { value: ERASE, label: "Erase" },
                    ...clocks.map((clock) => ({
                      value: String(clock.id),
                      label: clock.name,
                    })),
                  ]}
                />
              </div>
              <div className="min-w-40 text-xs">
                Starts
                <Select
                  aria-label="Starts"
                  value={start}
                  disabled={brush === ERASE}
                  onChange={(value) => setStart(value as "soft" | "hard")}
                  options={[
                    { value: "soft", label: "After the song" },
                    { value: "hard", label: "On the hour" },
                  ]}
                />
              </div>
              <label className="text-xs">
                Time zone
                <Input
                  aria-label="Time zone"
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.target.value)}
                />
              </label>
              <Button
                type="button"
                disabled={busy || !changed}
                onClick={() =>
                  void run(async () =>
                    show(
                      await saveRadioDayparts(programId, {
                        timeZone,
                        revision: grid.revision,
                        dayparts: daypartsFrom(cells),
                      }),
                    ),
                  )
                }
              >
                <Save size={13} /> Save grid
              </Button>
            </div>
            <DaypartGrid
              cells={cells}
              clocks={clocks}
              colorOf={colorOf}
              onPaint={paint}
            />
          </Card>
          <div className="space-y-4">
            {blocks.length > 0 && (
              <Card className="p-4">
                <h2 className="mb-2 text-sm font-bold">Blocks</h2>
                <ul className="space-y-1 text-sm">
                  {blocks.map((block) => (
                    <li key={block.id} className="flex items-center gap-2">
                      {block.daypart!.outcome && (
                        <span
                          role="img"
                          aria-label={
                            block.daypart!.outcome === "failed"
                              ? "Failed"
                              : "Skipped"
                          }
                          title={
                            block.daypart!.outcome === "failed"
                              ? "Failed"
                              : "Skipped"
                          }
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            block.daypart!.outcome === "failed"
                              ? "bg-red-600"
                              : "bg-accent-yellow"
                          }`}
                        />
                      )}
                      <Link to="/flight" className="text-accent-blue">
                        {block.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-bold">Clocks</h2>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => setEditing("new")}
                >
                  <Plus size={13} /> Clock
                </Button>
              </div>
              <ul className="mb-3 space-y-1">
                {clocks.map((clock) => (
                  <li key={clock.id} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`h-3 w-3 shrink-0 rounded-sm ${colorOf(clock.id)}`}
                    />
                    <button
                      type="button"
                      className="text-left text-sm"
                      aria-pressed={editing === clock.id}
                      onClick={() => setEditing(clock.id)}
                    >
                      {clock.name}
                    </button>
                  </li>
                ))}
              </ul>
              {(editing === "new" || edited) && (
                <ClockEditor
                  key={edited ? `${edited.id}:${edited.revision}` : "new"}
                  clock={edited}
                  labels={labels}
                  busy={busy}
                  onSave={(value) =>
                    void run(async () => {
                      const saved = edited
                        ? await updateRadioClock(programId, edited.id, {
                            ...value,
                            revision: edited.revision,
                          })
                        : await createRadioClock(programId, value);
                      setClocks(await fetchRadioClocks(programId));
                      setEditing(saved.id);
                    })
                  }
                  onDelete={(clock) =>
                    void run(async () => {
                      await deleteRadioClock(
                        programId,
                        clock.id,
                        clock.revision,
                      );
                      setClocks(await fetchRadioClocks(programId));
                      setBrush(ERASE);
                      setEditing(null);
                    })
                  }
                />
              )}
            </Card>
          </div>
        </div>
      )}
    </AppPage>
  );
}
