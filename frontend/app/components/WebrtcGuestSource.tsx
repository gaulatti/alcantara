import { useCallback } from 'react';
import { WebrtcGuestSource as BleeckerWebrtcGuestSource, type WebrtcCredentials } from '../bleecker';
import { apiUrl } from '../utils/apiBaseUrl';
import { noteRendererKeyAnswer, pageRendererKey } from '../utils/rendererKey';

/**
 * Reads the renderer key from the URL fragment (or the session) and asks the API for a room token
 * for this program. The Bleecker component only joins the room with what this returns.
 */
async function requestRoomCredentials(programId: string): Promise<WebrtcCredentials> {
  const rendererKey = pageRendererKey();
  if (!rendererKey) throw new Error('Renderer source credential is missing.');
  const response = await fetch(apiUrl('/webrtc/renderer-source-token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Renderer-Key': rendererKey,
    },
    body: JSON.stringify({ programId }),
  });
  noteRendererKeyAnswer(response.status);
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
