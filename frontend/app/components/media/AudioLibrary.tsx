import {
  Button,
  Checkbox,
  Empty,
  IconButton,
  Input,
  LoadingSpinner,
  StatusBadge,
} from "@gaulatti/bleecker";
import {
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ANALYSIS_LABELS,
  analysisCounts,
  analysisView,
  durationSeconds,
  filterByAnalysis,
  formatClock,
  formatCue,
  formatSigned,
  measured,
  percentOf,
  type AnalysisFilter,
  type AnalysisView,
  type AssetAnalysis,
  type AssetAnalysisField,
} from "../../utils/audioLibrary";

// gaulatti/alcantara#288, part B: the Audio tab as a dense list with a detail panel and one
// shared transport. One <audio> element plays whichever asset is loaded; it lives with this tab, so
// leaving the Media library stops it, and it never touches the console's radio listener (#287), which
// keeps playing in the layout.

export interface AudioLibraryAsset {
  id: string;
  name: string;
  sourceUrl: string;
  capabilities: string[];
  labels: Array<{ id: string; name: string }>;
  song: { durationMs: number | null } | null;
  /** Absent until the server sends it; null when the asset has no analysis row. */
  analysis?: AssetAnalysisField;
}

const CAPABILITY_LABELS: Record<string, string> = {
  INSTANT: "Instant",
  BACKGROUND: "Background",
  SONG: "Song",
  COVER: "Song cover",
  TRANSITION: "Transition",
};

const CAPABILITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any" },
  { value: "SONG", label: "Song" },
  { value: "INSTANT", label: "Instant" },
  { value: "BACKGROUND", label: "Background" },
  { value: "TRANSITION", label: "Transition" },
];

const ANALYSIS_FILTERS: Array<{ value: AnalysisFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "measured", label: "Measured" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
];

const BADGE_VARIANT: Record<
  AnalysisView,
  "live" | "warning" | "offline" | "default"
> = {
  measured: "live",
  pending: "warning",
  failed: "offline",
  none: "default",
  unavailable: "default",
};

function AnalysisPill({ analysis }: { analysis: AssetAnalysisField }) {
  const view = analysisView(analysis);
  const code = view === "failed" ? (analysis as AssetAnalysis).error : null;
  // One line, whatever the state: a failure code goes in the tooltip and the detail panel.
  return (
    <span
      data-testid="analysis-pill"
      title={code ? `${ANALYSIS_LABELS[view]} · ${code}` : undefined}
      className="inline-flex whitespace-nowrap"
    >
      <StatusBadge variant={BADGE_VARIANT[view]} label={ANALYSIS_LABELS[view]} />
    </span>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  counts,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-sm:flex max-sm:flex-wrap overflow-hidden rounded-[var(--radius-ui)] border border-sand/30"
    >
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value || "any"}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${pressed ? "bg-sea/15 text-sea" : "text-text-secondary hover:bg-sand/10"}`}
          >
            {option.label}
            {counts && counts[option.value] !== undefined ? (
              <span className="tabular-nums text-text-secondary">
                {counts[option.value]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The span of a song with its cue-in and cue-out markers; none when the asset has no length. */
function Timeline({
  length,
  analysis,
  position,
  large = false,
}: {
  length: number | null;
  analysis: AssetAnalysisField;
  position: number | null;
  large?: boolean;
}) {
  if (length === null)
    return (
      <span className="text-xs text-text-secondary">No duration stored</span>
    );
  const finished = measured(analysis);
  const cueIn = finished?.cueInSeconds ?? null;
  const cueOut = finished?.cueOutSeconds ?? null;
  const from = cueIn ?? 0;
  const to = cueOut ?? length;
  return (
    <div
      data-testid="timeline"
      className={`relative w-full ${large ? "h-10" : "h-5"}`}
    >
      <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-sand/25" />
      {finished ? (
        <span
          data-testid="timeline-live"
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-sea/70"
          style={{
            left: `${percentOf(from, length)}%`,
            right: `${100 - percentOf(to, length)}%`,
          }}
        />
      ) : null}
      {cueIn !== null ? (
        <span
          data-testid="cue-in"
          title={`In ${formatCue(cueIn)}`}
          className="absolute top-0 h-full w-0.5 bg-accent-text"
          style={{ left: `${percentOf(cueIn, length)}%` }}
        >
          {large ? (
            <span className="absolute -bottom-4 left-1 whitespace-nowrap text-[10px] text-text-secondary">
              In {formatCue(cueIn)}
            </span>
          ) : null}
        </span>
      ) : null}
      {cueOut !== null ? (
        <span
          data-testid="cue-out"
          title={`Out ${formatCue(cueOut)}`}
          className="absolute top-0 h-full w-0.5 bg-accent-text"
          style={{ left: `${percentOf(cueOut, length)}%` }}
        >
          {large ? (
            <span className="absolute -bottom-4 right-1 whitespace-nowrap text-[10px] text-text-secondary">
              Out {formatCue(cueOut)}
            </span>
          ) : null}
        </span>
      ) : null}
      {position !== null ? (
        <span
          data-testid="playhead"
          className="absolute top-0 h-full w-px bg-text-primary"
          style={{ left: `${percentOf(position, length)}%` }}
        />
      ) : null}
    </div>
  );
}

function Meter({
  label,
  unit,
  value,
  min,
  max,
  field,
  signed = false,
}: {
  label: string;
  unit: string;
  value: number | null;
  min: number;
  max: number;
  field: string;
  signed?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-ui)] border border-sand/25 p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {label}
      </h4>
      <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
        {value === null
          ? "—"
          : signed
            ? formatSigned(value)
            : value.toFixed(1)}
        <small className="ml-1 text-xs font-normal text-text-secondary">
          {unit}
        </small>
      </p>
      <div className="relative mt-2 h-1.5 rounded-full bg-sand/25">
        {value !== null ? (
          <span
            data-testid={`meter-${field}`}
            className="absolute top-[-3px] h-3 w-0.5 bg-sea"
            style={{ left: `${percentOf(value - min, max - min)}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-text-secondary">
        <span>{min}</span>
        <span>{max}</span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-text-secondary">{field}</p>
    </div>
  );
}

function Fields({ analysis }: { analysis: AssetAnalysisField }) {
  const finished = measured(analysis);
  const rows: Array<[string, string, string]> = [
    [
      "State",
      analysisView(analysis) === "failed" &&
      (analysis as AssetAnalysis).error
        ? `${ANALYSIS_LABELS.failed} · ${(analysis as AssetAnalysis).error}`
        : analysisView(analysis) === "none"
          ? "Not analysed yet"
          : ANALYSIS_LABELS[analysisView(analysis)],
      "status",
    ],
  ];
  if (analysis && analysis.status !== "success" && analysis.attempts != null) {
    rows.push([
      "Attempts",
      `${analysis.attempts} of 3${analysis.nextAttemptAt ? ` · next ${analysis.nextAttemptAt}` : ""}`,
      "attempts · nextAttemptAt",
    ]);
  }
  rows.push(
    [
      "Cue in",
      finished?.cueInSeconds != null
        ? `${finished.cueInSeconds.toFixed(2)} s`
        : "—",
      "cueInSeconds",
    ],
    [
      "Cue out",
      finished?.cueOutSeconds != null
        ? `${finished.cueOutSeconds.toFixed(2)} s`
        : "—",
      "cueOutSeconds",
    ],
    ["Fade in", "Not measured", "fadeInSeconds"],
    ["Fade out", "Not measured", "fadeOutSeconds"],
    ["Overlap", "Not measured", "overlapSeconds"],
  );
  if (finished?.isrc) rows.push(["ISRC", finished.isrc, "isrc"]);
  if (finished?.musicbrainzRecordingId)
    rows.push([
      "MusicBrainz",
      finished.musicbrainzRecordingId,
      "musicbrainzRecordingId",
    ]);
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
      {rows.map(([name, value, field]) => (
        <div key={field} className="contents">
          <dt className="text-text-secondary">
            {name}
            <span className="block font-mono text-[10px]">{field}</span>
          </dt>
          <dd className="text-right tabular-nums text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CapabilityList({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0)
    return <span className="text-xs text-text-secondary">No capability</span>;
  return (
    <>
      {capabilities.map((item) => (
        <span
          key={item}
          className="rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-[11px] font-medium text-sea"
        >
          {CAPABILITY_LABELS[item] ?? item}
        </span>
      ))}
    </>
  );
}

function Detail({
  asset,
  canDelete,
  onDelete,
  position,
}: {
  asset: AudioLibraryAsset;
  canDelete: boolean;
  onDelete: () => void;
  position: number | null;
}) {
  const length = durationSeconds(asset);
  const finished = measured(asset.analysis);
  return (
    <aside
      aria-label={`${asset.name} details`}
      aria-live="polite"
      className="space-y-5 border-t border-sand/25 p-4 lg:border-l lg:border-t-0"
    >
      <div>
        <h3 className="text-base font-semibold text-text-primary">
          {asset.name}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <CapabilityList capabilities={asset.capabilities} />
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          {asset.labels.length > 0
            ? asset.labels.map((label) => label.name).join(", ")
            : "Unlabeled"}
        </p>
      </div>
      <div>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          Timeline
        </h4>
        {length === null ? (
          <p className="text-xs text-text-secondary">
            No duration stored for this asset, so there is no timeline. The cue
            values are listed below.
          </p>
        ) : (
          <div className="pb-5">
            <Timeline
              length={length}
              analysis={asset.analysis}
              position={position}
              large
            />
            <div className="mt-5 flex justify-between text-[10px] tabular-nums text-text-secondary">
              <span>0:00</span>
              <span>{formatClock(length)}</span>
            </div>
          </div>
        )}
      </div>
      {finished ? (
        <div className="grid grid-cols-2 gap-3">
          <Meter
            label="Loudness"
            unit="LUFS"
            value={finished.integratedLufs}
            min={-30}
            max={0}
            field="integratedLufs"
          />
          <Meter
            label="True peak"
            unit="dBTP"
            value={finished.truePeakDbtp}
            min={-12}
            max={3}
            field="truePeakDbtp"
            signed
          />
        </div>
      ) : null}
      <div>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          Analysis
        </h4>
        {asset.analysis === undefined ? (
          <p className="text-xs text-text-secondary">
            Analysis unavailable: the media list did not include it.
          </p>
        ) : (
          <Fields analysis={asset.analysis} />
        )}
      </div>
      {canDelete ? (
        <div>
          <Button variant="secondary" size="sm" onClick={onDelete}>
            <Trash2 size={14} />
            Delete {asset.name}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

export interface AudioLibraryProps<T extends AudioLibraryAsset> {
  assets: T[];
  total: number;
  loading: boolean;
  capability: string;
  onCapabilityChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  filtered: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string, checked: boolean) => void;
  canDelete: (asset: T) => boolean;
  onDelete: (asset: T) => void;
  /** Bulk controls, shown while any asset is selected. */
  bulk?: ReactNode;
}

export function AudioLibrary<T extends AudioLibraryAsset>({
  assets,
  total,
  loading,
  capability,
  onCapabilityChange,
  search,
  onSearchChange,
  filtered,
  selectedIds,
  onToggleSelected,
  canDelete,
  onDelete,
  bulk,
}: AudioLibraryProps<T>) {
  const [analysisFilter, setAnalysisFilter] = useState<AnalysisFilter>("all");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [mediaLength, setMediaLength] = useState<number | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const counts = useMemo(() => analysisCounts(assets), [assets]);
  const visible = useMemo(
    () => filterByAnalysis(assets, analysisFilter),
    [assets, analysisFilter],
  );
  // The clip loaded in the audio element, when it is still listed; the transport shows and
  // controls only that clip, or else offers the first listed one without loading it.
  const loaded = visible.find((asset) => asset.id === currentId) ?? null;
  const current = loaded ?? visible[0] ?? null;
  const currentIndex = current ? visible.indexOf(current) : -1;
  const playingLoaded = playing && loaded !== null;

  // The audio element belongs to this tab: leaving the library stops the clip.
  useEffect(() => {
    const element = audioRef.current;
    return () => {
      if (element && !element.paused) element.pause();
    };
  }, []);

  const load = useCallback((asset: T | null) => {
    const element = audioRef.current;
    setCurrentId(asset?.id ?? null);
    setPosition(0);
    setMediaLength(null);
    setPlayError(null);
    setPlaying(false);
    /* v8 ignore next -- the shared audio element is always mounted with this tab, so the guard cannot see it missing */
    if (!element) return;
    if (!element.paused) element.pause();
    if (asset) element.src = asset.sourceUrl;
    else element.removeAttribute("src");
  }, []);

  // A filter, search or page change that unlists the loaded clip stops it and unloads it, so the
  // transport can never act on a different clip than the one that is audible.
  useEffect(() => {
    if (currentId !== null && loaded === null) load(null);
  }, [currentId, loaded, load]);

  const toggle = useCallback(
    (asset: T) => {
      const element = audioRef.current;
      /* v8 ignore next -- the shared audio element is always mounted with this tab, so the guard cannot see it missing */
      if (!element) return;
      if (asset.id !== currentId || !element.src) load(asset);
      if (element.paused) {
        setPlayError(null);
        void element.play().catch(() => {
          setPlaying(false);
          setPlayError("This clip cannot be played in the browser.");
        });
      } else {
        element.pause();
      }
    },
    [currentId, load],
  );

  const step = (direction: -1 | 1) => {
    const target = visible[currentIndex + direction];
    if (target) load(target);
  };

  const onRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    asset: T,
    index: number,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowDown" && visible[index + 1]) {
      event.preventDefault();
      load(visible[index + 1]);
      (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    } else if (event.key === "ArrowUp" && visible[index - 1]) {
      event.preventDefault();
      load(visible[index - 1]);
      (
        event.currentTarget.previousElementSibling as HTMLElement | null
      )?.focus();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle(asset);
    }
  };

  const currentLength = current
    ? (durationSeconds(current) ?? mediaLength)
    : null;
  const currentAnalysis = current ? measured(current.analysis) : null;

  return (
    <div className="space-y-3">
      <audio
        ref={audioRef}
        preload="none"
        data-testid="audio-transport"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) =>
          setMediaLength(
            Number.isFinite(event.currentTarget.duration)
              ? event.currentTarget.duration
              : null,
          )
        }
        onError={() => {
          setPlaying(false);
          if (audioRef.current?.getAttribute("src"))
            setPlayError("This clip cannot be played in the browser.");
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Analysis state"
          options={ANALYSIS_FILTERS}
          value={analysisFilter}
          onChange={setAnalysisFilter}
          counts={counts}
        />
        <Segmented
          label="Capability"
          options={CAPABILITY_FILTERS}
          value={capability}
          onChange={onCapabilityChange}
        />
        <div className="relative min-w-[14rem] flex-1 lg:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
            size={16}
          />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search audio media…"
            className="pl-9 pr-9"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
        {selectedIds.size > 0 ? bulk : null}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : visible.length === 0 ? (
        <Empty
          title="No audio media found"
          description={
            filtered || analysisFilter !== "all"
              ? "Clear the filters and try again."
              : "This physical media type has no assets yet."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-sand/25">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="max-h-[34rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-dark-sand/80 text-left text-[11px] uppercase tracking-wide text-text-secondary backdrop-blur">
                  <tr>
                    <th className="w-8 px-2 py-2" aria-label="Select" />
                    <th className="w-10 px-2 py-2" aria-label="Play" />
                    <th className="px-2 py-2 font-semibold">Name</th>
                    <th className="hidden px-2 py-2 font-semibold min-[1400px]:table-cell">
                      Timeline · cue in / out
                    </th>
                    <th className="px-2 py-2 text-right font-semibold">
                      Length
                    </th>
                    <th className="hidden px-2 py-2 text-right font-semibold md:table-cell">
                      LUFS
                    </th>
                    <th className="hidden px-2 py-2 text-right font-semibold md:table-cell">
                      Peak
                    </th>
                    <th className="hidden px-2 py-2 font-semibold sm:table-cell">Analysis</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((asset, index) => {
                    const length = durationSeconds(asset);
                    const finished = measured(asset.analysis);
                    const isCurrent = asset.id === current?.id;
                    const isPlaying = isCurrent && playingLoaded;
                    return (
                      <tr
                        key={asset.id}
                        tabIndex={0}
                        aria-selected={isCurrent}
                        onClick={() => {
                          if (!isCurrent) load(asset);
                        }}
                        onKeyDown={(event) => onRowKeyDown(event, asset, index)}
                        className={`cursor-pointer border-t border-sand/15 outline-none transition focus-visible:ring-1 focus-visible:ring-sea ${isCurrent ? "bg-sea/10" : "hover:bg-sand/10"}`}
                      >
                        <td className="px-2 py-2">
                          <label
                            className="inline-flex items-center justify-center max-sm:-m-3 max-sm:min-h-11 max-sm:min-w-11"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              aria-label={`Select ${asset.name}`}
                              checked={selectedIds.has(asset.id)}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                onToggleSelected(asset.id, event.target.checked)
                              }
                            />
                          </label>
                        </td>
                        <td className="px-2 py-2">
                          <IconButton
                            aria-label={`${isPlaying ? "Pause" : "Play"} ${asset.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(asset);
                            }}
                          >
                            {isPlaying ? (
                              <Pause size={14} />
                            ) : (
                              <Play size={14} />
                            )}
                          </IconButton>
                        </td>
                        <td className="min-w-0 max-sm:max-w-0 px-2 py-2">
                          <p className="truncate font-medium text-text-primary">
                            {asset.name}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
                            <CapabilityList capabilities={asset.capabilities} />
                            <span>
                              {asset.labels.length > 0
                                ? asset.labels
                                    .map((label) => label.name)
                                    .join(" · ")
                                : "Unlabeled"}
                            </span>
                          </p>
                        </td>
                        <td className="hidden w-48 px-2 py-2 min-[1400px]:table-cell">
                          <Timeline
                            length={length}
                            analysis={asset.analysis}
                            position={
                              isCurrent && length !== null ? position : null
                            }
                          />
                        </td>
                        <td
                          className={`px-2 py-2 text-right tabular-nums ${length === null ? "text-text-secondary" : "text-text-primary"}`}
                        >
                          {formatClock(length)}
                        </td>
                        <td
                          className={`hidden px-2 py-2 text-right font-mono tabular-nums md:table-cell ${finished ? "text-text-primary" : "text-text-secondary"}`}
                        >
                          {finished?.integratedLufs != null
                            ? finished.integratedLufs.toFixed(1)
                            : "—"}
                        </td>
                        <td
                          className={`hidden px-2 py-2 text-right font-mono tabular-nums md:table-cell ${finished ? "text-text-primary" : "text-text-secondary"}`}
                        >
                          {formatSigned(finished?.truePeakDbtp)}
                        </td>
                        <td className="hidden px-2 py-2 sm:table-cell">
                          <AnalysisPill analysis={asset.analysis} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {current ? (
              <Detail
                asset={current}
                canDelete={canDelete(current)}
                onDelete={() => onDelete(current)}
                position={
                  playing || position > 0
                    ? durationSeconds(current) !== null
                      ? position
                      : null
                    : null
                }
              />
            ) : /* v8 ignore next -- the detail panel is part of the branch that renders only while a clip is listed, so current is never null here */ null}
          </div>

          <div
            role="group"
            aria-label="Audio transport"
            className="flex items-center gap-4 border-t border-sand/25 bg-dark-sand/60 px-4 py-3"
          >
            <div className="flex items-center gap-1">
              <IconButton
                aria-label="Previous"
                disabled={currentIndex <= 0}
                onClick={() => step(-1)}
              >
                <SkipBack size={14} />
              </IconButton>
              <IconButton
                aria-label={playingLoaded ? "Pause" : "Play"}
                disabled={!current}
                onClick={() => current && toggle(current)}
              >
                {playingLoaded ? <Pause size={16} /> : <Play size={16} />}
              </IconButton>
              <IconButton
                aria-label="Next"
                disabled={currentIndex < 0 || currentIndex >= visible.length - 1}
                onClick={() => step(1)}
              >
                <SkipForward size={14} />
              </IconButton>
            </div>
            <div className="min-w-0 basis-56">
              <p className="truncate text-sm font-medium text-text-primary">
                {current?.name ?? /* v8 ignore next -- the transport renders only while a clip is listed, so current is never null here */ "Nothing loaded"}
              </p>
              <p className="truncate text-[11px] text-text-secondary">
                {current
                  ? [
                      current.capabilities
                        .map((item) => CAPABILITY_LABELS[item] ?? item)
                        .join(" · "),
                      currentAnalysis?.integratedLufs != null
                        ? `${currentAnalysis.integratedLufs.toFixed(1)} LUFS`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : /* v8 ignore next -- the transport renders only while a clip is listed (visible is non-empty), so current is never null here */ ""}
              </p>
              {playError ? (
                <p role="alert" className="text-[11px] text-accent-red">
                  {playError}
                </p>
              ) : null}
            </div>
            <div className="hidden min-w-0 flex-1 sm:block">
              {currentLength !== null ? (
                <Timeline
                  length={currentLength}
                  analysis={current?.analysis}
                  position={position}
                />
              ) : null}
            </div>
            <p className="shrink-0 text-xs tabular-nums text-text-secondary">
              <b className="text-text-primary">{formatClock(position)}</b> /{" "}
              {formatClock(currentLength)}
            </p>
          </div>
        </div>
      )}
      <p className="text-xs text-text-secondary">
        {analysisFilter === "all"
          ? `${total} asset${total === 1 ? "" : "s"}`
          : `${visible.length} of ${assets.length} on this page`}
      </p>
    </div>
  );
}
