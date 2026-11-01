import { Button } from "@gaulatti/bleecker";
import { useCallback, useEffect, useState } from "react";
import {
  exportSimilaritySongs,
  fetchSimilarityCoverage,
  fetchSimilarityDecisions,
  fetchSimilaritySettings,
  saveSimilaritySettings,
  uploadSimilarityEmbeddings,
  type EmbeddingUploadResult,
  type SimilarityCoverage,
  type SimilarityDecision,
  type SimilarityDecisionSong,
  type SimilarityMode,
  type SimilarityPool,
  type SimilaritySettings,
} from "../services/similarity";

export interface SongSimilarityFixtureData {
  settings: SimilaritySettings;
  coverage: SimilarityCoverage;
  decisions: SimilarityDecision[];
  error?: string;
  uploadSummary?: string;
}

const DEFAULT_SETTINGS: SimilaritySettings = {
  similarityMode: "off",
  similarityThreshold: 0.8,
  similarityWindowSeconds: 30,
  similarityPool: "sequence",
};

const MODE_HELP: Record<SimilarityMode, string> = {
  off: "Selection is unchanged.",
  shadow: "On-air selection is unchanged; proposals are recorded below.",
  on: "The closest passing song plays next; otherwise selection falls back.",
};

const song = (value: SimilarityDecisionSong | null) =>
  value ? `${value.artist} — ${value.title}` : "—";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function SongSimilarityPanel({
  programId,
  fixtureData,
}: {
  programId: string;
  fixtureData?: SongSimilarityFixtureData;
}) {
  const [settings, setSettings] = useState<SimilaritySettings>(
    fixtureData?.settings ?? DEFAULT_SETTINGS,
  );
  const [coverage, setCoverage] = useState<SimilarityCoverage | null>(
    fixtureData?.coverage ?? null,
  );
  const [decisions, setDecisions] = useState<SimilarityDecision[]>(
    fixtureData?.decisions ?? [],
  );
  const [scope, setScope] = useState<"sequence" | "catalog">("sequence");
  const [missingOnly, setMissingOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(fixtureData?.error ?? null);
  const [notice, setNotice] = useState<string | null>(
    fixtureData?.uploadSummary ?? null,
  );

  const load = useCallback(async () => {
    const [loaded, cov, recent] = await Promise.all([
      fetchSimilaritySettings(programId),
      fetchSimilarityCoverage(programId),
      fetchSimilarityDecisions(programId),
    ]);
    if (loaded) setSettings(loaded);
    setCoverage(cov);
    setDecisions(recent);
  }, [programId]);

  useEffect(() => {
    if (fixtureData) return;
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Similarity unavailable."),
    );
  }, [fixtureData, load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const threshold = settings.similarityThreshold;
  const invalid =
    !Number.isFinite(threshold) ||
    threshold < -1 ||
    threshold > 1 ||
    !Number.isInteger(settings.similarityWindowSeconds) ||
    settings.similarityWindowSeconds < 5 ||
    settings.similarityWindowSeconds > 120;

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const text = await file.text();
      const results: EmbeddingUploadResult[] = await uploadSimilarityEmbeddings(
        programId,
        text,
        (done, total) => setNotice(`Uploading ${done}/${total}…`),
      );
      const stored = results.filter((r) => r.status === "stored").length;
      const rejected = results.filter((r) => r.status === "rejected");
      setNotice(
        `${stored} stored, ${rejected.length} rejected.` +
          (rejected.length
            ? ` ${rejected
                .slice(0, 5)
                .map((r) => `#${r.songId ?? "?"}: ${r.reason}`)
                .join("; ")}`
            : ""),
      );
      await load();
    });
  };

  const field =
    "mt-1 w-full rounded-lg border border-border-subtle bg-transparent px-2 py-1.5 text-sm";

  return (
    <section
      className="rounded-[var(--radius-ui)] border border-sand/25 p-4 dark:border-white/10"
      aria-label="Song similarity"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">
        Selection
      </p>
      <h3 className="mt-1 text-lg font-semibold">Song similarity</h3>
      <p className="mt-1 text-sm text-text-secondary">
        Chooses the next song by comparing the end of the song that just played
        with the start of each candidate. Model:{" "}
        {coverage
          ? `${coverage.model.name} (${coverage.model.license}, non-commercial)`
          : "discogs-effnet-bs64-1"}
        .
      </p>
      {coverage ? (
        <p className="mt-2 text-sm" role="status">
          {coverage.embeddedSongs} of {coverage.enabledSongs} enabled songs
          analyzed at {coverage.windowSeconds}s
          {coverage.missingSongs > 0
            ? ` — ${coverage.missingSongs} missing`
            : ""}
          .
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          Mode
          <select
            className={field}
            value={settings.similarityMode}
            onChange={(e) =>
              setSettings({
                ...settings,
                similarityMode: e.target.value as SimilarityMode,
              })
            }
          >
            <option value="off">Off</option>
            <option value="shadow">Shadow</option>
            <option value="on">On</option>
          </select>
        </label>
        <label className="text-sm">
          Threshold (−1 to 1)
          <input
            className={field}
            type="number"
            step="0.01"
            min={-1}
            max={1}
            value={settings.similarityThreshold}
            onChange={(e) =>
              setSettings({
                ...settings,
                similarityThreshold: e.target.valueAsNumber,
              })
            }
          />
        </label>
        <label className="text-sm">
          Window (seconds)
          <input
            className={field}
            type="number"
            min={5}
            max={120}
            value={settings.similarityWindowSeconds}
            onChange={(e) =>
              setSettings({
                ...settings,
                similarityWindowSeconds: e.target.valueAsNumber,
              })
            }
          />
        </label>
        <label className="text-sm">
          Candidates
          <select
            className={field}
            value={settings.similarityPool}
            onChange={(e) =>
              setSettings({
                ...settings,
                similarityPool: e.target.value as SimilarityPool,
              })
            }
          >
            <option value="sequence">Playlist only</option>
            <option value="catalog">Playlist, then whole catalog</option>
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-text-secondary">
        {MODE_HELP[settings.similarityMode]} Changing the window needs a new
        analysis at that window.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-emerald-300">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Button
          type="button"
          disabled={busy || invalid}
          onClick={() =>
            void run(async () => {
              await saveSimilaritySettings(programId, settings);
              setNotice("Saved.");
              await load();
            })
          }
        >
          Save
        </Button>
        <label className="text-sm">
          Export scope
          <select
            className={field}
            value={scope}
            onChange={(e) => setScope(e.target.value as "sequence" | "catalog")}
          >
            <option value="sequence">Songs in the playlist</option>
            <option value="catalog">Whole catalog</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={missingOnly}
            onChange={(e) => setMissingOnly(e.target.checked)}
          />
          Only songs without embeddings
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              download(
                "songs-to-analyze.json",
                await exportSimilaritySongs(programId, scope, missingOnly),
              );
            })
          }
        >
          Export songs to analyze
        </Button>
        <label className="text-sm">
          <span className="block">Upload embeddings.json</span>
          <input
            className="mt-1 text-sm"
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h4 className="text-sm font-semibold">Recent decisions</h4>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void run(load)}
        >
          Refresh
        </Button>
      </div>
      {decisions.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="py-1 pr-3">Time</th>
                <th className="pr-3">After</th>
                <th className="pr-3">Proposed</th>
                <th className="pr-3">Score</th>
                <th className="pr-3">Played</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id} className="border-t border-border-subtle">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {new Date(d.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="pr-3">{song(d.current)}</td>
                  <td className="pr-3">{song(d.proposed)}</td>
                  <td className="pr-3">
                    {d.score === null ? "—" : d.score.toFixed(3)}
                  </td>
                  <td className="pr-3">{song(d.played)}</td>
                  <td>{d.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-text-secondary">
          No decisions recorded yet. Set the mode to Shadow to start recording.
        </p>
      )}
    </section>
  );
}
