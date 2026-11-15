import React, { useEffect, useRef } from 'react';
import { Button, Card, Empty } from '@gaulatti/bleecker';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { SourceRow } from './SourceRow';
import type { ExternalSource } from '../../services/externalSources';

export interface SourceListProps {
  sources: ExternalSource[];
  currentProgramId: string;
  selectedIds: Set<string>;
  onToggleSelect: (source: ExternalSource) => void;
  onRefresh: () => void;
  isLoading?: boolean;
  error?: string | null;
  className?: string;
}

export function SourceList({
  sources,
  currentProgramId,
  selectedIds,
  onToggleSelect,
  onRefresh,
  isLoading = false,
  error = null,
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

      {/* Non-destructive Error Banner (kept while previous list is visible) */}
      {error && (
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
      {programSources.length === 0 ? (
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
              <tr className="border-b border-zinc-800 bg-zinc-900/30 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
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
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
