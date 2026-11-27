import type { ReactNode } from 'react';

/**
 * A panel that is closed until someone needs it: one line with its name and its state, and the
 * controls behind it. For the sections of a page that are inactive most of the time.
 */
export function DisclosureRow({
  title,
  summary,
  warn = false,
  label,
  children,
}: {
  title: string;
  /** The section's state in a few words, shown while it is closed. */
  summary: ReactNode;
  /** The state needs attention, so the summary takes the warning colour. */
  warn?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-[var(--radius-ui)] border border-sand/20 dark:border-white/10" aria-label={label ?? title}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue">
        <span aria-hidden="true" className="text-xs text-text-secondary transition-transform group-open:rotate-90 motion-reduce:transition-none">▸</span>
        <h2 className="shrink-0 text-sm font-semibold text-text-primary">{title}</h2>
        <span className={`min-w-0 truncate text-xs ${warn ? 'text-accent-yellow' : 'text-text-secondary'}`}>{summary}</span>
      </summary>
      <div className="space-y-3 border-t border-sand/20 p-3 dark:border-white/10">{children}</div>
    </details>
  );
}
