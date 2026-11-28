import { useEffect, useRef, useState } from "react";
import { Button } from "@gaulatti/bleecker";
import { Tags } from "lucide-react";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { generateTaggedLog, type RadioLogRules } from "../services/flight";
import { TagBlockFields } from "./TagBlockFields";
import type { FlightCue, FlightSequence } from "../models/broadcast";

export function RadioLogGenerator({
  programId,
  log,
  onGenerated,
  fixtureLabels,
}: {
  programId: string;
  log: FlightSequence | null;
  onGenerated: (items: FlightCue[]) => void;
  fixtureLabels?: { id: string; name: string }[];
}) {
  const [labels, setLabels] = useState(fixtureLabels ?? []);
  const [rules, setRules] = useState<RadioLogRules>({
    slots: [{ labelId: "", count: 1, clockOffsetSeconds: 0 }],
    artistSeparation: 2,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestTarget = `${programId}:${log?.id}:${log?.revision}`;
  const currentTarget = useRef(requestTarget);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  currentTarget.current = requestTarget;
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
    !log || !!log.publishedAt || !!log.lastStartedAt || log.isRunning;
  const generate = async (current: FlightSequence) => {
    setBusy(true);
    setError(null);
    try {
      const generated = await generateTaggedLog(
        programId,
        current.id,
        current.revision,
        rules,
      );
      if (mounted.current && currentTarget.current === requestTarget)
        onGenerated(generated.items);
    } catch (cause) {
      if (mounted.current && currentTarget.current === requestTarget)
        setError(cause instanceof Error ? cause.message : "Generation failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="rounded-xl border border-border-subtle bg-sand/5 p-4"
      aria-label="Generate rundown from tags"
    >
      <h2 className="flex items-center gap-2 text-sm font-bold">
        <Tags size={16} /> Build from tags
      </h2>
      <p className="mt-2 text-xs text-text-secondary">
        Tags define the music pool. Arrange blocks for this block; generation
        picks each song once and favors songs used least recently in the
        previous 24 published blocks.
      </p>
      <fieldset disabled={locked || busy} className="mt-4 space-y-3">
        <TagBlockFields
          rules={rules}
          onChange={setRules}
          labels={labels}
          disabled={locked || busy}
        />
        <Button
          type="button"
          className="w-full"
          onClick={log ? () => void generate(log) : undefined}
          disabled={rules.slots.some((slot) => !slot.labelId)}
        >
          {busy
            ? "Generating…"
            : log?.items.length
              ? "Replace draft from tags"
              : "Generate draft"}
        </Button>
      </fieldset>
      <p className="mt-3 text-xs text-text-secondary">
        {locked
          ? "Choose an unaired draft to generate."
          : "Review the generated events, then Save and Publish. Tags never change a saved rundown."}
      </p>
      {labels.length === 0 && !error && (
        <p className="mt-2 text-xs">
          Create tags and label songs in the Library first.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-terracotta">
          {error}
        </p>
      )}
      <a href="/media" className="mt-3 inline-block text-xs text-accent-blue">
        Manage Library tags
      </a>
    </section>
  );
}
