import { apiUrl } from '../utils/apiBaseUrl';
import type { ProgramState, ProgramAudioBusSettings, BroadcastSettings, ProgramAudioMeterLevels, ProgramSongPlaybackState, SceneInstantPlaybackState } from '../models/broadcast';

export async function fetchProgramState(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/state`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchProgramAudioBusSettings(targetProgramId: string): Promise<ProgramAudioBusSettings | null> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function persistMixerSettings(
  targetProgramId: string,
  mixerSettings: { mainMasterVolume: number; mixerChannels: unknown }
): Promise<ProgramAudioBusSettings | null> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mixerSettings })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveProgramAudioBusSongSequence(
  targetProgramId: string,
  songSequence: unknown
): Promise<ProgramAudioBusSettings | null> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songSequence })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchProgramAudioMeter(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-meter`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchProgramSongPlayback(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song-playback`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function takeSongOffAir(targetProgramId: string): Promise<void> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song/off-air`), {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fetchSceneInstantPlayback(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scene-instant`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function takeSceneInstant(
  targetProgramId: string,
  sceneId: number,
  instantId: number | null
): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scene-instant/take`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, instantId })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function stopSceneInstant(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scene-instant/stop`), {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function assignSceneToProgram(targetProgramId: string, sceneId: number): Promise<void> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scenes`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function stageSceneForProgram(targetProgramId: string, sceneId: number | null): Promise<void> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/stage`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function activateScene(
  targetProgramId: string,
  sceneId: number,
  transitionId?: string | null
): Promise<void> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/activate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, transitionId })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fetchMediaGroups(targetProgramId: string): Promise<unknown> {
  const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/media-groups`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
