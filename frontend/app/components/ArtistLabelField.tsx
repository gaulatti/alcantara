import { Button, Select } from "@gaulatti/bleecker";
import { useEffect, useState } from "react";
import {
  artistKeyOf,
  fetchArtistLabels,
  saveArtistLabel,
} from "../services/artistLabels";
import { fetchAllMediaLabels } from "../services/mediaLabels";

interface LabelOption {
  id: string;
  name: string;
  assetCount: number;
}

const NO_LABEL = "";

/**
 * The media label attached to an artist (gaulatti/alcantara#423): the pictures the song recipe's
 * slideshow and the artist bumper use for every song by that artist. It saves for the artist as
 * typed, not for one song, so it has its own button.
 */
export function ArtistLabelField({ artist }: { artist: string }) {
  const [labels, setLabels] = useState<LabelOption[] | null>(null);
  const [linked, setLinked] = useState<Map<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAllMediaLabels<LabelOption>(),
      fetchArtistLabels(),
    ])
      .then(([loadedLabels, rows]) => {
        if (cancelled) return;
        setLabels(loadedLabels);
        setLinked(new Map(rows.map((row) => [row.artistKey, row.labelId])));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const key = artistKeyOf(artist);
  const saved = linked.get(key) ?? NO_LABEL;
  const value = chosen ?? saved;
  const selected = labels?.find((label) => label.id === value);
  const canSave = Boolean(key) && value !== saved && !saving;

  const save = async () => {
    setSaving(true);
    setNotice(null);
    setSaveError(null);
    try {
      await saveArtistLabel(artist.trim(), value === NO_LABEL ? null : value);
      setLinked((current) => {
        const next = new Map(current);
        if (value === NO_LABEL) next.delete(key);
        else next.set(key, value);
        return next;
      });
      setChosen(null);
      setNotice(
        value === NO_LABEL
          ? "Artist label removed."
          : "Artist label saved for every song by this artist.",
      );
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <p role="alert" className="text-xs text-terracotta">
        {loadError}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-sand/30 bg-sand/5 p-3">
      <p className="text-sm font-semibold text-text-primary">Artist label</p>
      <p className="text-xs text-text-secondary">
        The media label whose pictures stand for this artist, for every song by
        them.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <Select
            aria-label="Artist label"
            value={value}
            disabled={labels === null || !key}
            onChange={(next) => setChosen(next)}
            options={[
              { value: NO_LABEL, label: "No artist label" },
              ...(labels ?? []).map((label) => ({
                value: label.id,
                label: `${label.name} (${label.assetCount} ${label.assetCount === 1 ? "image" : "images"})`,
              })),
            ]}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save artist label"}
        </Button>
      </div>
      {selected && selected.assetCount === 0 ? (
        <p role="status" className="text-xs text-terracotta">
          This label has no images yet, so the slideshow and the artist bumper
          will have nothing to show for this artist.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-text-secondary">
          {notice}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-xs text-terracotta">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
