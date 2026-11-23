// The Labels view of the media library (gaulatti/alcantara#288, part C): the media mix of a
// label, how labels are sorted, and how a change time reads. Everything comes from the label's
// assets (MediaAssetLabel -> MediaAsset.mediaType) and its updatedAt.

export type LabelMediaType = "AUDIO" | "IMAGE" | "VIDEO";

export interface LabelLike {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
  assets: Array<{ position: number; asset: { id: string; mediaType: string } }>;
  updatedAt: string;
}

export type LabelSort = "used" | "name" | "changed";

/** How many of a label's listed assets are of each media type. */
export function mediaMix(label: LabelLike): Record<LabelMediaType, number> {
  const mix: Record<LabelMediaType, number> = { AUDIO: 0, IMAGE: 0, VIDEO: 0 };
  for (const { asset } of label.assets) {
    if (asset.mediaType in mix) mix[asset.mediaType as LabelMediaType] += 1;
  }
  return mix;
}

export function sortLabels<T extends LabelLike>(
  labels: T[],
  sort: LabelSort,
): T[] {
  const byName = (left: T, right: T) => left.name.localeCompare(right.name);
  const sorted = [...labels];
  if (sort === "name") return sorted.sort(byName);
  if (sort === "changed")
    return sorted.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        byName(left, right),
    );
  return sorted.sort(
    (left, right) => right.assetCount - left.assetCount || byName(left, right),
  );
}

export function matchesLabel(label: LabelLike, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    label.name.toLowerCase().includes(needle) ||
    (label.description ?? "").toLowerCase().includes(needle)
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Today 09:12", "Yesterday", or "Nov 18" (with the year when it is not this year). */
export function formatChanged(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `Today ${hours}:${minutes}`;
  }
  if (days === 1) return "Yesterday";
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear()
    ? base
    : `${base}, ${date.getFullYear()}`;
}

/** The order after dragging the item at `from` onto the item at `to`. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0) return items;
  if (from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
