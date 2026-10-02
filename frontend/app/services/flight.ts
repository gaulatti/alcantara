import { apiUrl } from '../utils/apiBaseUrl';
import type { FlightCue, FlightSequence } from '../models/broadcast';

async function flightError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  const detail = body && typeof body === 'object' && 'message' in body ? body.message : null;
  return new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.join('; ') : `Radio log request failed (${response.status})`);
}

export async function fetchFlightSequences(targetProgramId: string): Promise<FlightSequence[]> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight`));
  if (!res.ok) throw await flightError(res);
  return res.json();
}

export async function createFlightSequence(
  targetProgramId: string,
  data: { name: string; items?: FlightCue[]; loop?: boolean; scheduledAt?: string | null }
): Promise<FlightSequence> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw await flightError(res);
  return res.json();
}

export async function updateFlightSequence(
  targetProgramId: string,
  sequenceId: number,
  data: { name?: string; items?: FlightCue[]; loop?: boolean; scheduledAt?: string | null; revision?: number }
): Promise<FlightSequence> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/${sequenceId}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }
  );
  if (!res.ok) throw await flightError(res);
  return res.json();
}

export async function deleteFlightSequence(
  targetProgramId: string,
  sequenceId: number
): Promise<{ deletedId: number }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/${sequenceId}`),
    { method: 'DELETE' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function activateFlightSequence(
  targetProgramId: string,
  sequenceId: number
): Promise<{ activeSequenceId: number | null }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/${sequenceId}/activate`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deactivateFlightSequence(
  targetProgramId: string
): Promise<{ activeSequenceId: null }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/deactivate`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function startFlight(targetProgramId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/start`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function stopFlight(targetProgramId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/stop`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function goFlight(targetProgramId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/go`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resetFlight(targetProgramId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/reset`),
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function preflightFlightSequence(targetProgramId: string, sequenceId: number): Promise<{ ready: boolean; issues: string[] }> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/${sequenceId}/preflight`));
  if (!res.ok) throw await flightError(res);
  return res.json();
}

export async function publishFlightSequence(targetProgramId: string, sequenceId: number, revision: number): Promise<FlightSequence> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/flight/${sequenceId}/publish`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision })
  });
  if (!res.ok) throw await flightError(res);
  return res.json();
}
