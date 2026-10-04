import { useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@gaulatti/bleecker";
import { Plus, Tags, Trash2 } from "lucide-react";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { generateTaggedLog, type RadioLogRules } from "../services/flight";
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
  const patchSlot = (
    index: number,
    patch: Partial<RadioLogRules["slots"][number]>,
  ) =>
    setRules((current) => ({
      ...current,
      slots: current.slots.map((slot, row) =>
        row === index ? { ...slot, ...patch } : slot,
      ),
    }));
  const generate = async () => {
    if (!log) return;
    setBusy(true);
    setError(null);
    try {
      const generated = await generateTaggedLog(
        programId,
        log.id,
        log.revision,
        rules,
      );
      if (currentTarget.current === requestTarget) onGenerated(generated.items);
    } catch (cause) {
      if (currentTarget.current === requestTarget)
        setError(cause instanceof Error ? cause.message : "Generation failed");
    } finally {
      setBusy(false);
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
        Tags define the music pool. Arrange blocks for this hour; generation
        picks each song once and favors songs used least recently in the
        previous 24 published hours.
      </p>
      <fieldset disabled={locked || busy} className="mt-4 space-y-3">
        {rules.slots.map((slot, index) => (
          <div
            key={index}
            className="space-y-2 border-b border-border-subtle pb-3"
          >
            <div className="flex items-center justify-between">
              <span className="console-eyebrow">Block {index + 1}</span>
              {index > 0 && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove block ${index + 1}`}
                  onClick={() =>
                    setRules((current) => ({
                      ...current,
                      slots: current.slots.filter((_, row) => row !== index),
                    }))
                  }
                >
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
            <Select
              aria-label={`Tag for block ${index + 1}`}
              value={slot.labelId}
              disabled={locked || busy}
              onChange={(value) => patchSlot(index, { labelId: value })}
              options={[
                { value: "", label: "Choose a Library tag" },
                ...labels.map((label) => ({
                  value: label.id,
                  label: label.name,
                })),
              ]}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                Songs
                <Input
                  aria-label={`Song count for block ${index + 1}`}
                  type="number"
                  min="1"
                  max="120"
                  value={slot.count}
                  onChange={(event) =>
                    patchSlot(index, { count: Number(event.target.value) })
                  }
                />
              </label>
              <label className="text-xs">
                Fixed start (+sec)
                <Input
                  aria-label={`Fixed start for block ${index + 1}`}
                  type="number"
                  min="0"
                  max="3599"
                  placeholder="Follows"
                  disabled={index === 0}
                  value={slot.clockOffsetSeconds ?? ""}
                  onChange={(event) =>
                    patchSlot(index, {
                      clockOffsetSeconds:
                        event.target.value === ""
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="xs"
          variant="secondary"
          onClick={() =>
            setRules((current) => ({
              ...current,
              slots: [...current.slots, { labelId: "", count: 1 }],
            }))
          }
          disabled={rules.slots.length >= 120}
        >
          <Plus size={13} /> Music block
        </Button>
        <label className="block text-xs">
          Songs between the same artist
          <Input
            aria-label="Artist separation"
            type="number"
            min="0"
            max="20"
            value={rules.artistSeparation}
            onChange={(event) =>
              setRules((current) => ({
                ...current,
                artistSeparation: Number(event.target.value),
              }))
            }
          />
        </label>
        <Button
          type="button"
          className="w-full"
          onClick={() => void generate()}
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
