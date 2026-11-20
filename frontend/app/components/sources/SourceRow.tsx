import React from 'react';
import { Button, StatusBadge } from '@gaulatti/bleecker';
import { Eye, EyeOff } from 'lucide-react';
import { isPreviewable, type ExternalSource } from '../../services/externalSources';

export interface SourceRowProps {
  source: ExternalSource;
  isSelected: boolean;
  onToggleSelect: (source: ExternalSource) => void;
  className?: string;
}

export function getLifecycleBadge(lifecycle: ExternalSource['lifecycle']) {
  switch (lifecycle) {
    case 'connected':
      return { variant: 'live' as const, label: 'connected', colorClass: 'text-emerald-400 bg-emerald-950/40 border-emerald-800' };
    case 'degraded':
      return { variant: 'offline' as const, label: 'degraded', colorClass: 'text-amber-400 bg-amber-950/40 border-amber-800' };
    case 'reconnecting':
      return { variant: 'offline' as const, label: 'reconnecting', colorClass: 'text-yellow-300 bg-yellow-950/40 border-yellow-800' };
    case 'waiting':
      return { variant: 'default' as const, label: 'waiting', colorClass: 'text-sky-400 bg-sky-950/40 border-sky-800' };
    case 'provisioning':
      return { variant: 'default' as const, label: 'provisioning', colorClass: 'text-indigo-400 bg-indigo-950/40 border-indigo-800' };
    case 'unconfigured':
      return { variant: 'default' as const, label: 'unconfigured', colorClass: 'text-zinc-400 bg-zinc-900 border-zinc-700' };
    case 'offline':
      return { variant: 'default' as const, label: 'offline', colorClass: 'text-zinc-500 bg-zinc-900/60 border-zinc-800' };
    case 'revoked':
      return { variant: 'default' as const, label: 'revoked', colorClass: 'text-rose-400 bg-rose-950/40 border-rose-800' };
  }
}

export function getHealthBadge(health: ExternalSource['health']) {
  switch (health) {
    case 'healthy':
      return { dot: 'bg-emerald-400', label: 'healthy', textColor: 'text-emerald-400' };
    case 'degraded':
      return { dot: 'bg-amber-400', label: 'degraded', textColor: 'text-amber-400' };
    case 'unavailable':
      return { dot: 'bg-rose-400', label: 'unavailable', textColor: 'text-rose-400' };
    case 'unknown':
    default:
      return { dot: 'bg-zinc-500', label: 'unknown', textColor: 'text-zinc-400' };
  }
}

export function SourceRow({
  source,
  isSelected,
  onToggleSelect,
  className = '',
}: SourceRowProps) {
  const canPreview = isPreviewable(source);
  const lifecycleInfo = getLifecycleBadge(source.lifecycle);
  const healthInfo = getHealthBadge(source.health);

  return (
    <tr
      data-testid={`source-row-${source.id}`}
      aria-selected={isSelected}
      className={`border-b border-zinc-800/60 transition-colors hover:bg-zinc-900/40 ${
        isSelected ? 'bg-zinc-900/70' : ''
      } ${className}`}
    >
      {/* Selection action */}
      <td className="w-12 px-3 py-2.5 text-center">
        <Button
          id={`toggle-preview-${source.id}`}
          variant={isSelected ? 'primary' : 'secondary'}
          size="sm"
          disabled={!canPreview}
          aria-disabled={!canPreview ? 'true' : undefined}
          aria-pressed={isSelected}
          aria-label={
            canPreview
              ? isSelected
                ? `Stop previewing ${source.name}`
                : `Preview ${source.name}`
              : `${source.name} cannot be previewed in ${source.lifecycle} state`
          }
          title={
            canPreview
              ? isSelected
                ? 'Deselect preview'
                : 'Preview source'
              : 'Cannot preview in current lifecycle'
          }
          onClick={() => {
            if (canPreview) {
              onToggleSelect(source);
            }
          }}
          className={`h-7 w-7 p-0 ${
            !canPreview ? 'opacity-30 cursor-not-allowed' : ''
          }`}
        >
          {isSelected ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-zinc-400" />
          )}
        </Button>
      </td>

      {/* Name */}
      <td className="px-3 py-2.5 font-medium text-sm text-zinc-100">
        <div className="flex flex-col">
          <span data-testid={`source-name-${source.id}`} className="truncate max-w-xs sm:max-w-md">
            {source.name}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {source.participantIdentity ?? 'no participant'}
          </span>
        </div>
      </td>

      {/* Transport */}
      <td className="px-3 py-2.5 text-xs text-zinc-400 uppercase font-mono">
        <span
          data-testid={`source-transport-${source.id}`}
          className="rounded bg-zinc-800/80 px-1.5 py-0.5"
        >
          {source.transport}
        </span>
      </td>

      {/* Lifecycle (All 8 distinctly formatted) */}
      <td className="px-3 py-2.5 text-xs">
        <span
          data-testid={`source-lifecycle-${source.id}`}
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${lifecycleInfo.colorClass}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {lifecycleInfo.label}
        </span>
      </td>

      {/* Health (All 4 distinctly formatted) */}
      <td className="px-3 py-2.5 text-xs">
        <div
          data-testid={`source-health-${source.id}`}
          className="flex items-center gap-1.5"
        >
          <span className={`h-2 w-2 rounded-full ${healthInfo.dot}`} />
          <span className={`capitalize font-medium ${healthInfo.textColor}`}>
            {healthInfo.label}
          </span>
        </div>
      </td>
    </tr>
  );
}
