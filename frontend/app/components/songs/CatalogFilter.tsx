/**
 * A segmented filter of the song catalog (All, Enabled, Disabled): one choice, always one chosen.
 * Its props are the SegmentedFilter pinned in bleecker#549, so it can be swapped for Bleecker's.
 */
export function CatalogFilter<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-[var(--radius-ui)] border border-sand/30"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${option.value === value ? "bg-sea/15 text-sea" : "text-text-secondary hover:bg-sand/10"}`}
        >
          {option.label}
          {option.count !== undefined ? (
            <span className="tabular-nums text-text-secondary">{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
