import { apiUrl } from '../utils/apiBaseUrl';
import type { Scene, ComponentPropsMap } from '../models/broadcast';

export async function fetchScenes(): Promise<Scene[]> {
  const res = await fetch(apiUrl('/scenes'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchLayouts(): Promise<unknown> {
  const res = await fetch(apiUrl('/layouts'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createScene(payload: {
  name: string;
  layoutId: number;
  metadata: unknown;
}): Promise<Scene> {
  const res = await fetch(apiUrl('/scenes'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateScene(
  sceneId: number,
  payload: { name?: string; layoutId?: number; metadata?: unknown }
): Promise<Scene> {
  const res = await fetch(apiUrl(`/scenes/${sceneId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function persistSceneAttributes(
  sceneId: number,
  nextMetadata: ComponentPropsMap
): Promise<Scene> {
  const res = await fetch(apiUrl(`/scenes/${sceneId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata: nextMetadata })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteScene(id: number): Promise<void> {
  const res = await fetch(apiUrl(`/scenes/${id}`), {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
