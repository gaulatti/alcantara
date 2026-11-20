import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, Alert } from '@gaulatti/bleecker';
import { AppPage } from '../components/AppPage';
import { useGlobalProgramId } from '../utils/globalProgram';
import { apiUrl } from '../utils/apiBaseUrl';
import { authFetch } from '../services/api';
import {
  fetchExternalSources,
  isSelectableLifecycle,
  type ExternalSource,
} from '../services/externalSources';
import {
  SourcesSubscriptionProvider,
  useSourcesSubscriptionContext,
} from '../components/sources/SourcesSubscriptionContext';
import { SourceList } from '../components/sources/SourceList';
import { SourcePreviewTile } from '../components/sources/SourcePreviewTile';
import { Room } from 'livekit-client';

export type PreviewAvailability = 'connecting' | 'ready' | 'unconfigured' | 'denied' | 'failed';

export const PREVIEW_UNAVAILABLE_MESSAGES: Record<Exclude<PreviewAvailability, 'ready'>, string> = {
  connecting: 'Connecting live preview...',
  unconfigured: 'Live preview is not available: the media service is not configured on this server.',
  denied: "You don't have permission to preview sources.",
  failed: 'Live preview could not connect.',
};

export function meta() {
  return [{ title: 'External Sources - Alcántara' }];
}

function SourcesManagerContent({
  sources,
  currentProgramId,
  isLoading,
  error,
  onRefresh,
  previewAvailability,
  onRetryPreview,
}: {
  previewAvailability: PreviewAvailability;
  onRetryPreview: () => void;
  sources: ExternalSource[];
  currentProgramId: string;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const handleToggleSelect = useCallback((source: ExternalSource) => {
    if (!isSelectableLifecycle(source.lifecycle)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(source.id)) {
        next.delete(source.id);
      } else {
        next.add(source.id);
      }
      return next;
    });
  }, []);

  const handleDeselect = useCallback((sourceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(sourceId);
      return next;
    });
  }, []);

  const selectedSources = sources.flatMap((s) =>
    selectedIds.has(s.id) && s.participantIdentity !== null ? [{ ...s, participantIdentity: s.participantIdentity }] : []
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Active Preview Area */}
      {selectedSources.length > 0 && (
        <section aria-labelledby="sources-preview-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 id="sources-preview-heading" className="text-sm font-semibold text-zinc-200">
              Active Source Previews ({selectedSources.length})
            </h2>
            <span className="text-xs text-zinc-400">
              Only selected sources are subscribed. No output is routed to Program.
            </span>
          </div>
          <div
            data-testid="preview-tiles-grid"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {selectedSources.map((source) => (
              <SourcePreviewTile
                key={source.id}
                source={source}
                onDeselect={() => handleDeselect(source.id)}
              />
            ))}
          </div>
        </section>
      )}

      {previewAvailability !== 'ready' && (
        <div role="status" data-testid="preview-availability" className="flex items-center gap-3 text-sm text-amber-300">
          <span>{PREVIEW_UNAVAILABLE_MESSAGES[previewAvailability]}</span>
          {previewAvailability === 'failed' && (
            <button
              type="button"
              onClick={onRetryPreview}
              className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-100 hover:bg-zinc-800"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Source List Section */}
      <section aria-label="External sources registry">
        <SourceList
          sources={sources}
          currentProgramId={currentProgramId}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          previewUnavailableReason={
            previewAvailability === 'ready' ? null : PREVIEW_UNAVAILABLE_MESSAGES[previewAvailability]
          }
          onRefresh={onRefresh}
          isLoading={isLoading}
          error={error}
        />
      </section>
    </div>
  );
}

export interface SourcesRouteProps {
  initialSources?: ExternalSource[];
  room?: any;
}

export default function SourcesRoute({ initialSources, room: testRoom }: SourcesRouteProps) {
  const [programId] = useGlobalProgramId();
  const [sources, setSources] = useState<ExternalSource[]>(initialSources ?? []);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<any>(testRoom ?? null);
  const roomRef = useRef<any>(testRoom ?? null);
  const [previewAvailability, setPreviewAvailability] = useState<PreviewAvailability>(
    testRoom ? 'ready' : 'connecting'
  );
  const [connectAttempt, setConnectAttempt] = useState(0);
  const retryPreview = useCallback(() => setConnectAttempt((n) => n + 1), []);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchExternalSources();
      setSources(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch external sources');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Connect to LiveKit room for operator preview if not provided
  useEffect(() => {
    if (testRoom) {
      setActiveRoom(testRoom);
      setPreviewAvailability('ready');
      return;
    }
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let roomInstance: Room | null = null;

    async function connectLiveKit() {
      setPreviewAvailability('connecting');
      try {
        const configRes = await fetch(apiUrl('/webrtc/config'));
        if (!configRes.ok) {
          if (!cancelled) setPreviewAvailability('unconfigured');
          return;
        }
        const config = (await configRes.json()) as { livekit?: { enabled?: boolean } };
        if (!config.livekit?.enabled) {
          if (!cancelled) setPreviewAvailability('unconfigured');
          return;
        }

        const tokenRes = await authFetch('/webrtc/operator-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ programId }),
        });
        if (!tokenRes.ok) {
          if (!cancelled) setPreviewAvailability(tokenRes.status === 401 || tokenRes.status === 403 ? 'denied' : 'failed');
          return;
        }
        const creds = (await tokenRes.json()) as { serverUrl: string; token: string };

        if (cancelled) return;

        // autoSubscribe: false ensures joining subscribes to nothing!
        roomInstance = new Room();
        await roomInstance.connect(creds.serverUrl, creds.token, { autoSubscribe: false });

        if (!cancelled) {
          roomRef.current = roomInstance;
          setActiveRoom(roomInstance);
          setPreviewAvailability('ready');
        } else {
          roomInstance.disconnect();
        }
      } catch {
        if (!cancelled) setPreviewAvailability('failed');
      }
    }

    void connectLiveKit();

    return () => {
      cancelled = true;
      if (roomInstance) {
        roomInstance.disconnect();
      }
    };
  }, [programId, testRoom, connectAttempt]);

  // Initial load and periodic refresh
  useEffect(() => {
    if (!initialSources) {
      void loadSources();
    }
    const interval = setInterval(() => {
      void loadSources();
    }, 10000);

    return () => clearInterval(interval);
  }, [initialSources, loadSources]);

  return (
    <AppPage width="wide">
      <div className="flex flex-col gap-6">
        <PageHeader
          title="External Sources"
          description="Monitor and preview managed external video and audio sources assigned to the active program."
        />

        <SourcesSubscriptionProvider room={activeRoom}>
          <SourcesManagerContent
            sources={sources}
            currentProgramId={programId}
            isLoading={isLoading}
            error={error}
            onRefresh={loadSources}
            previewAvailability={previewAvailability}
            onRetryPreview={retryPreview}
          />
        </SourcesSubscriptionProvider>
      </div>
    </AppPage>
  );
}
