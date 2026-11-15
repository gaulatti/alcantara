import { authFetch } from './api';

export type ExternalSourceLifecycle =
  | 'unconfigured'
  | 'provisioning'
  | 'waiting'
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'offline'
  | 'revoked';

export type ExternalSourceHealth =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unavailable';

export interface ExternalSource {
  id: string;
  name: string;
  transport: string;
  lifecycle: ExternalSourceLifecycle;
  health: ExternalSourceHealth;
  participantIdentity: string;
  lastConnectedAt: string | null;
  revokedAt: string | null;
  programIds: string[];
  teamId?: number;
  normalizationProfile?: string;
  credentialVersion?: number;
  createdAt?: string;
  updatedAt?: string;
}

export const PREVIEWABLE_LIFECYCLES: ReadonlySet<ExternalSourceLifecycle> = new Set<ExternalSourceLifecycle>([
  'connected',
  'degraded',
  'reconnecting',
]);

export function isSelectableLifecycle(lifecycle: ExternalSourceLifecycle): boolean {
  return PREVIEWABLE_LIFECYCLES.has(lifecycle);
}

export async function fetchExternalSources(): Promise<ExternalSource[]> {
  const response = await authFetch('/external-sources');
  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText) as { message?: string };
      if (parsed.message) {
        message = parsed.message;
      }
    } catch {
      // Use raw text or fallback
    }
    throw new Error(message || `Failed to fetch external sources (${response.status})`);
  }
  return response.json() as Promise<ExternalSource[]>;
}
