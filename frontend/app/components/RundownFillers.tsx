import { useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@gaulatti/bleecker";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { fillRundown } from "../services/flight";

export function RundownFillers({
  programId,
  rundown,
  items,
  onFilled,
  fixtureLabels,
}: {
  programId: string;
  rundown: FlightSequence | null;
  items: FlightCue[];
  onFilled: (items: FlightCue[]) => void;
  fixtureLabels?: { id: string; name: string }[];
}) {
  const [labels, setLabels] = useState(fixtureLabels ?? []);
  const [labelId, setLabelId] = useState("");
  const [separation, setSeparation] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const identity = `${programId}:${rundown?.id}:${rundown?.revision}:${JSON.stringify(items)}`;
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    if (fixtureLabels) return;
    let mounted = true;
    void fetchAllMediaLabels()
      .then((result) => {
        if (mounted) setLabels(result);
      })
      .catch((cause) => {
        if (mounted)
          setError(cause instanceof Error ? cause.message : "Tags unavailable");
      });
    return () => {
      mounted = false;
    };
  }, [fixtureLabels]);
  const locked =
    !rundown ||
    !!rundown.publishedAt ||
    !!rundown.lastStartedAt ||
    rundown.isRunning;
  async function fill() {
    if (!rundown) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const preview = await fillRundown(
        programId,
        rundown.id,
        rundown.revision,
        items,
        { labelId, artistSeparation: separation },
      );
      if (current.current === identity) {
        setWarnings(preview.warnings);
        onFilled(preview.items);
      }
    } catch (cause) {
      if (current.current === identity)
        setError(
          cause instanceof Error ? cause.message : "Filler preview failed",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Rundown fillers"
      className="rounded-xl border border-border-subtle bg-sand/5 p-4"
    >
      <h2 className="text-sm font-bold">Fill the gaps</h2>
      <p className="mt-2 text-xs text-text-secondary">
        Keep your timed content. Fillers cover the gaps to each fixed block and
        the end of the hour. The next fixed start cuts the last filler if
        needed.
      </p>
      <fieldset disabled={locked || busy} className="mt-3 space-y-3">
        <Select
          aria-label="Filler tag"
          disabled={locked || busy}
          value={labelId}
          onChange={setLabelId}
          options={[
            { value: "", label: "Choose a filler tag" },
            ...labels.map((label) => ({ value: label.id, label: label.name })),
          ]}
        />
        <label className="block text-xs">
          Songs between the same artist
          <Input
            aria-label="Filler artist separation"
            type="number"
            min="0"
            max="20"
            value={separation}
            onChange={(event) => setSeparation(Number(event.target.value))}
          />
        </label>
        <Button
          type="button"
          className="w-full"
          disabled={!labelId || !items.length}
          onClick={() => void fill()}
        >
          {busy ? "Filling…" : "Preview fillers"}
        </Button>
      </fieldset>
      <p className="mt-3 text-xs text-text-secondary">
        Song durations come from the catalog. Enter clip durations in the
        rundown. Explicit Stop events keep their silence. Review, Save, then
        Publish.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-terracotta">
          {error}
        </p>
      )}
      {warnings.length > 0 && (
        <ul
          aria-label="Filler timing warnings"
          className="mt-3 space-y-2 text-xs text-text-secondary"
        >
          {warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
