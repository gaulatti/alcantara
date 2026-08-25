import { apiUrl } from '../utils/apiBaseUrl';
import type { InstantItem } from '../models/broadcast';

export async function fetchInstants(programId?: string): Promise<InstantItem[]> {
  const query = programId ? `?programId=${encodeURIComponent(programId)}` : '';
  const res = await fetch(apiUrl(`/instants${query}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function triggerInstant(instantId: number, programId: string): Promise<void> {
  const res = await fetch(apiUrl(`/instants/${instantId}/play?programId=${encodeURIComponent(programId)}`), {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function stopAllInstants(programId: string): Promise<void> {
  const res = await fetch(apiUrl(`/instants/stop-all?programId=${encodeURIComponent(programId)}`), {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
