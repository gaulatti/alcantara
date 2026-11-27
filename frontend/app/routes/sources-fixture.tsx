import { useSearchParams } from 'react-router';
import { SourceList } from '../components/sources/SourceList';
import type { SourcePreviewStatus } from '../components/sources/SourceList';
import type { ExternalSource } from '../services/externalSources';

const sources: ExternalSource[] = [
  { id: 'cam-1', name: 'Studio camera', transport: 'whip', lifecycle: 'connected', health: 'healthy', participantIdentity: 'studio-cam', lastConnectedAt: null, revokedAt: null, programIds: ['main'] },
  { id: 'van-1', name: 'Outside van', transport: 'srt', lifecycle: 'reconnecting', health: 'degraded', participantIdentity: 'van', lastConnectedAt: null, revokedAt: null, programIds: ['main'] }
];

const states = ['ready', 'loading', 'error', 'empty', 'preview-failed', 'preview-unconfigured'] as const;
type State = (typeof states)[number];

const previews: Partial<Record<State, SourcePreviewStatus>> = {
  ready: { tone: 'ok', label: 'Preview ready', reason: null },
  'preview-failed': { tone: 'bad', label: 'Preview off · connection failed', reason: 'Live preview could not connect.', onRetry: () => undefined },
  'preview-unconfigured': { tone: 'warn', label: 'Preview off · no media service', reason: 'Live preview is not available: the media service is not configured on this server.' }
};

// The external sources list with fictional sources, one state per ?state=:
// ready (default), loading, error (first load failed), empty, preview-failed
// and preview-unconfigured.
export default function SourcesFixture() {
  const [params] = useSearchParams();
  const requested = (params.get('state') ?? '') as State;
  const state = states.includes(requested) ? requested : 'ready';
  return (
    <main className='min-h-screen broadcast-console bg-dark-sand p-6 text-text-primary' data-visual-fixture={state}>
      <div className='mx-auto max-w-6xl'>
        <SourceList
          sources={state === 'empty' ? [] : sources}
          currentProgramId='main'
          selectedIds={new Set()}
          onToggleSelect={() => undefined}
          onRefresh={() => undefined}
          hasLoaded={state !== 'loading' && state !== 'error'}
          isLoading={state === 'loading'}
          error={state === 'error' ? 'HTTP 503' : null}
          preview={previews[state] ?? null}
        />
      </div>
    </main>
  );
}
