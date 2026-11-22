import {
  Button,
  Empty,
  IconButton,
  Input,
  LoadingSpinner,
  Select,
} from "@gaulatti/bleecker";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import {
  formatChanged,
  matchesLabel,
  mediaMix,
  moveItem,
  sortLabels,
  type LabelLike,
  type LabelMediaType,
  type LabelSort,
} from "../../utils/labelLibrary";

// gaulatti/alcantara#288, part C: the Labels view as a management table (the media mix and the
// count of each label) with a drawer that lists the label's media in the order stored in
// MediaAssetLabel.position, rearranged by drag. Moving with the buttons stays available for the
// keyboard.

export interface LabelsViewAsset {
  id: string;
  name: string;
  mediaType: string;
  sourceUrl: string;
}

export interface LabelsViewLabel extends LabelLike {
  assets: Array<{ position: number; asset: LabelsViewAsset }>;
}

const SORTS: Array<{ value: LabelSort; label: string }> = [
  { value: "used", label: "Most used" },
  { value: "name", label: "A–Z" },
  { value: "changed", label: "Recently changed" },
];

const MIX: Array<{ type: LabelMediaType; label: string; bar: string }> = [
  { type: "AUDIO", label: "audio", bar: "bg-sea" },
  { type: "IMAGE", label: "image", bar: "bg-desert" },
  { type: "VIDEO", label: "video", bar: "bg-dusk" },
];

function MixBar({ label }: { label: LabelLike }) {
  const mix = mediaMix(label);
  const listed = mix.AUDIO + mix.IMAGE + mix.VIDEO;
  if (listed === 0)
    return <span className="text-xs text-text-secondary">No media</span>;
  return (
    <div>
      <div
        role="img"
        aria-label={MIX.filter((part) => mix[part.type] > 0)
          .map((part) => `${mix[part.type]} ${part.label}`)
          .join(", ")}
        className="flex h-2 overflow-hidden rounded-full bg-sand/20"
      >
        {MIX.map((part) =>
          mix[part.type] > 0 ? (
            <span
              key={part.type}
              data-testid={`mix-${part.label}`}
              className={part.bar}
              style={{ width: `${(mix[part.type] / listed) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-secondary">
        {MIX.map((part) =>
          mix[part.type] > 0 ? (
            <span key={part.type} className="inline-flex items-center gap-1">
              <i className={`inline-block h-2 w-2 rounded-sm ${part.bar}`} />
              {mix[part.type]} {part.label}
            </span>
          ) : null,
        )}
      </p>
    </div>
  );
}

export interface LabelsViewProps<T extends LabelsViewLabel> {
  labels: T[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onCreate: () => void;
  onEdit: (label: T) => void;
  onDelete: (label: T) => void;
  /** Every asset that can be added to the selected label. */
  addableAssets: LabelsViewAsset[];
  /** Resolves true when the asset was added. */
  onAddAsset: (label: T, assetId: string) => Promise<boolean>;
  onRemoveAsset: (label: T, assetId: string) => Promise<void>;
  /** Stores a new order of the label's assets. */
  onReorder: (label: T, assetIds: string[]) => Promise<void>;
  now?: Date;
}

export function LabelsView<T extends LabelsViewLabel>({
  labels,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  onCreate,
  onEdit,
  onDelete,
  addableAssets,
  onAddAsset,
  onRemoveAsset,
  onReorder,
  now,
}: LabelsViewProps<T>) {
  const [sort, setSort] = useState<LabelSort>("used");
  const [adding, setAdding] = useState(false);
  const [assetToAdd, setAssetToAdd] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const rows = useMemo(
    () =>
      sortLabels(
        labels.filter((label) => matchesLabel(label, search)),
        sort,
      ),
    [labels, search, sort],
  );
  const selected = labels.find((label) => label.id === selectedId) ?? null;
  const ordered = selected ? selected.assets.map((entry) => entry.asset) : [];

  const reorder = (from: number, to: number) => {
    if (!selected) return;
    const next = moveItem(ordered, from, to);
    if (next === ordered) return;
    void onReorder(
      selected,
      next.map((asset) => asset.id),
    );
  };

  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, to: number) => {
    event.preventDefault();
    if (dragFrom !== null) reorder(dragFrom, to);
    endDrag();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1 lg:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
            size={16}
          />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search labels…"
            className="pl-9"
          />
        </div>
        <div
          role="group"
          aria-label="Sort"
          className="inline-flex overflow-hidden rounded-[var(--radius-ui)] border border-sand/30"
        >
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sort === option.value}
              onClick={() => setSort(option.value)}
              className={`px-3 py-1.5 text-xs font-medium transition ${sort === option.value ? "bg-sea/15 text-sea" : "text-text-secondary hover:bg-sand/10"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Button onClick={onCreate}>
          <Plus size={16} />
          New label
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : labels.length === 0 ? (
        <Empty
          title="No labels yet"
          description="Create a label, then apply it to any media asset."
        />
      ) : (
        <div className="grid overflow-hidden rounded-[var(--radius-card)] border border-sand/25 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="max-h-[34rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-dark-sand/80 text-left text-[11px] uppercase tracking-wide text-text-secondary backdrop-blur">
                <tr>
                  <th className="px-3 py-2 font-semibold">Label</th>
                  <th className="hidden w-56 px-3 py-2 font-semibold md:table-cell">
                    Media mix
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">Assets</th>
                  <th className="hidden px-3 py-2 font-semibold md:table-cell">
                    Changed
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((label) => {
                  const isSelected = label.id === selected?.id;
                  return (
                    <tr
                      key={label.id}
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={() => onSelect(label.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(label.id);
                        }
                      }}
                      className={`cursor-pointer border-t border-sand/15 outline-none transition focus-visible:ring-1 focus-visible:ring-sea ${isSelected ? "bg-sea/10" : "hover:bg-sand/10"}`}
                    >
                      <td className="px-3 py-2">
                        <p className="font-medium text-text-primary">
                          {label.name}
                        </p>
                        {label.description ? (
                          <p className="mt-0.5 text-xs text-text-secondary">
                            {label.description}
                          </p>
                        ) : null}
                      </td>
                      <td className="hidden px-3 py-2 md:table-cell">
                        <MixBar label={label} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                        {label.assetCount}
                      </td>
                      <td className="hidden px-3 py-2 text-xs text-text-secondary md:table-cell">
                        {formatChanged(label.updatedAt, now)}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-sm text-text-secondary"
                    >
                      No label matches the search.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <aside
            aria-label={selected ? `${selected.name} details` : "Label details"}
            aria-live="polite"
            className="space-y-5 border-t border-sand/25 p-4 lg:border-l lg:border-t-0"
          >
            {!selected ? (
              <Empty
                title="Select a label"
                description="Labels can group and order any media without creating a separate collection."
              />
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-text-primary">
                      {selected.name}
                    </h3>
                    {selected.description ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        {selected.description}
                      </p>
                    ) : null}
                  </div>
                  <IconButton
                    aria-label={`Delete ${selected.name}`}
                    onClick={() => onDelete(selected)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-[var(--radius-ui)] border border-sand/25 p-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                      Assets
                    </h4>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
                      {selected.assetCount}
                    </p>
                  </div>
                  <div className="rounded-[var(--radius-ui)] border border-sand/25 p-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                      Audio
                    </h4>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
                      {mediaMix(selected).AUDIO}
                      <small className="ml-1 text-xs font-normal text-text-secondary">
                        of {selected.assetCount}
                      </small>
                    </p>
                  </div>
                </div>
                <div>
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                    Order{" "}
                    <span className="font-mono normal-case tracking-normal">
                      MediaAssetLabel.position
                    </span>
                  </h4>
                  {ordered.length === 0 ? (
                    <Empty
                      title="No media with this label"
                      description="Add existing media here, or apply this label while uploading images."
                    />
                  ) : (
                    <ol className="space-y-1">
                      {ordered.map((asset, index) => (
                        <li
                          key={asset.id}
                          draggable
                          data-testid={`order-${asset.id}`}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", asset.id);
                            setDragFrom(index);
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setDragOver(index);
                          }}
                          onDrop={(event) => onDrop(event, index)}
                          onDragEnd={endDrag}
                          className={`group flex items-center gap-2 rounded-[var(--radius-ui)] border px-2 py-1.5 text-sm ${dragOver === index && dragFrom !== index ? "border-sea" : "border-sand/25"} ${dragFrom === index ? "opacity-50" : ""}`}
                        >
                          <GripVertical
                            size={14}
                            aria-hidden="true"
                            className="shrink-0 cursor-grab text-text-secondary"
                          />
                          <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-text-secondary">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-text-primary">
                            {asset.name}
                          </span>
                          <span className="shrink-0 text-[11px] text-text-secondary">
                            {asset.mediaType.toLowerCase()}
                          </span>
                          <span className="flex shrink-0 gap-0.5">
                            <IconButton
                              aria-label={`Move ${asset.name} up`}
                              disabled={index === 0}
                              onClick={() => reorder(index, index - 1)}
                            >
                              <ArrowUp size={13} />
                            </IconButton>
                            <IconButton
                              aria-label={`Move ${asset.name} down`}
                              disabled={index === ordered.length - 1}
                              onClick={() => reorder(index, index + 1)}
                            >
                              <ArrowDown size={13} />
                            </IconButton>
                            <IconButton
                              aria-label={`Remove ${asset.name} from ${selected.name}`}
                              onClick={() =>
                                void onRemoveAsset(selected, asset.id)
                              }
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {selected.assetCount > ordered.length ? (
                    <p className="mt-2 text-xs text-text-secondary">
                      and {selected.assetCount - ordered.length} more
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => onEdit(selected)}>
                      <Pencil size={14} />
                      Rename
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-expanded={adding}
                      onClick={() => setAdding((current) => !current)}
                    >
                      <Plus size={14} />
                      Add assets
                    </Button>
                  </div>
                  {adding ? (
                    <div className="flex gap-2">
                      <Select
                        value={assetToAdd}
                        onChange={setAssetToAdd}
                        options={[
                          { value: "", label: "Choose media…" },
                          ...addableAssets
                            .filter(
                              (asset) =>
                                !ordered.some((entry) => entry.id === asset.id),
                            )
                            .map((asset) => ({
                              value: asset.id,
                              label: `${asset.name} · ${asset.mediaType.toLowerCase()}`,
                            })),
                        ]}
                      />
                      <Button
                        variant="secondary"
                        disabled={!assetToAdd}
                        onClick={() => {
                          void onAddAsset(selected, assetToAdd).then((added) => {
                            if (added) setAssetToAdd("");
                          });
                        }}
                      >
                        Add
                      </Button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
