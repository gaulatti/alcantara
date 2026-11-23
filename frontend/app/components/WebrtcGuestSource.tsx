import { useCallback } from 'react';
import { WebrtcGuestSource as BleeckerWebrtcGuestSource, type WebrtcCredentials } from '../bleecker';
import { apiUrl } from '../utils/apiBaseUrl';

const RENDERER_KEY_STORAGE = 'alcantara-renderer-key';

/**
 * Reads the renderer key from the URL fragment (or the session) and asks the API for a room token
 * for this program. The Bleecker component only joins the room with what this returns.
 */
async function requestRoomCredentials(programId: string): Promise<WebrtcCredentials> {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const rendererKey = fragment.get('key') || window.sessionStorage.getItem(RENDERER_KEY_STORAGE) || '';
  if (rendererKey) window.sessionStorage.setItem(RENDERER_KEY_STORAGE, rendererKey);
  if (!rendererKey) throw new Error('Renderer source credential is missing.');
  const response = await fetch(apiUrl('/webrtc/renderer-source-token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Renderer-Key': rendererKey,
    },
    body: JSON.stringify({ programId }),
  });
  if (!response.ok) throw new Error(`Guest source authorization failed (${response.status}).`);
  return (await response.json()) as WebrtcCredentials;
}

/** One guest slot of the program's WebRTC room, authorized through the API. */
export function WebrtcGuestSource({
  programId,
  ...display
}: {
  programId: string;
  slotNumber?: unknown;
  objectFit?: unknown;
  channelGain?: unknown;
  showStatus?: unknown;
  suppressAudio?: boolean;
}) {
  const getCredentials = useCallback(() => requestRoomCredentials(programId), [programId]);
  return <BleeckerWebrtcGuestSource getCredentials={getCredentials} {...display} />;
}
