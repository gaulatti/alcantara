import React, { useEffect, useRef } from 'react';
import { Button, Card, Empty, ErrorState, SkeletonTable, StatePill } from '@gaulatti/bleecker';
import type { StatePillTone } from '@gaulatti/bleecker';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { SourceRow } from './SourceRow';
import type { ExternalSource } from '../../services/externalSources';

export interface SourceListProps {
  sources: ExternalSource[];
  currentProgramId: string;
  selectedIds: Set<string>;
  onToggleSelect: (source: ExternalSource) => void;
  onRefresh: () => void;
  /** Page-level reason preview is unavailable (media service, permission, connection); null when ready. */
  previewUnavailableReason?: string | null;
  isLoading?: boolean;
  /** False until the first list has arrived: the card shows skeleton rows, or an error state with retry. */
  hasLoaded?: boolean;
  error?: string | null;
  /** Preview availability as a state with its reason; null when there is nothing to report. */
  preview?: SourcePreviewStatus | null;
  className?: string;
}

export interface SourcePreviewStatus {
  tone: StatePillTone;
  label: string;
  reason: string | null;
  onRetry?: () => void;
}

export function SourceList({
  sources,
  currentProgramId,
  selectedIds,
  onToggleSelect,
  onRefresh,
  previewUnavailableReason = null,
  isLoading = false,
  hasLoaded = true,
  error = null,
  preview = null,
  className = '',
}: SourceListProps) {
  const lastFocusedIdRef = useRef<string | null>(null);

  // Filter sources for current program
  const programSources = sources.filter((s) => s.programIds.includes(currentProgramId));

  // Focus preservation across refresh
  useEffect(() => {
    if (lastFocusedIdRef.current) {
      const el = document.getElementById(lastFocusedIdRef.current);
      if (el && document.activeElement !== el) {
        el.focus();
      }
    }
  });

  const handleFocusCapture = (e: React.FocusEvent) => {
    if (e.target && (e.target as HTMLElement).id) {
      lastFocusedIdRef.current = (e.target as HTMLElement).id;
    }
  };

  return (
    <Card
      className={`flex flex-col border border-zinc-800 bg-zinc-950 p-0 overflow-hidden shadow-sm ${className}`}
      data-testid="source-list-card"
      onFocusCapture={handleFocusCapture}
    >
      {/* List Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-sm text-zinc-100">Managed External Sources</h3>
          {preview ? <StatePill tone={preview.tone} label={preview.label} title={preview.reason ?? undefined} /> : null}
          <span className="text-xs text-zinc-400 font-mono">
            Program: <span className="text-zinc-200">{currentProgramId}</span> (
            {programSources.length})
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label="Refresh sources list"
          className="flex items-center gap-1.5 text-xs text-zinc-300"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin text-sea' : 'text-zinc-400'}`}
          />
          <span>Refresh</span>
        </Button>
      </div>

      {preview?.reason ? (
        <div role="status" data-testid="preview-availability" className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-200">
          <span>{preview.reason}</span>
          {preview.onRetry ? (
            <Button type="button" variant="secondary" size="sm" onClick={preview.onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Non-destructive Error Banner (kept while previous list is visible) */}
      {error && hasLoaded && (
        <div
          role="alert"
          data-testid="source-list-error"
          className="flex items-center gap-2 border-b border-rose-800/60 bg-rose-950/60 px-4 py-2 text-xs text-rose-200"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>Failed to refresh external sources: {error}. Retaining current list.</span>
        </div>
      )}

      {/* Sources Table */}
      {!hasLoaded && error ? (
        <div className="p-8" data-testid="source-list-load-error">
          <ErrorState title="External sources could not be loaded" description={error} onRetry={onRefresh} retryLabel="Retry loading sources" />
        </div>
      ) : !hasLoaded ? (
        <div className="p-4" role="status" aria-label="Loading external sources" data-testid="source-list-loading">
          <SkeletonTable rows={4} columns={5} />
        </div>
      ) : programSources.length === 0 ? (
        <div className="p-8">
          <Empty
            title="No external sources assigned"
            description={`No external video or audio sources are assigned to program "${currentProgramId}".`}
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse" role="table" aria-label="External sources">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/30 text-xs font-medium uppercase tracking-wider text-zinc-400">
                <th scope="col" className="w-12 px-3 py-2 text-center">
                  Preview
                </th>
                <th scope="col" className="px-3 py-2">
                  Source & Participant
                </th>
                <th scope="col" className="px-3 py-2">
                  Transport
                </th>
                <th scope="col" className="px-3 py-2">
                  Lifecycle
                </th>
                <th scope="col" className="px-3 py-2">
                  Health
                </th>
              </tr>
            </thead>
            <tbody>
              {programSources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  isSelected={selectedIds.has(source.id)}
                  onToggleSelect={onToggleSelect}
                  previewUnavailableReason={previewUnavailableReason}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
