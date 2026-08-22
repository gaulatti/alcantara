import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';

export function WebrtcGuestSource({
  programId,
  slotNumber,
  objectFit = 'cover',
  channelGain = 1,
  showStatus = true,
  suppressAudio = false
}: {
  programId: string;
  slotNumber?: unknown;
  objectFit?: unknown;
  channelGain?: unknown;
  showStatus?: unknown;
  suppressAudio?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [connectionState, setConnectionState] = useState(ConnectionState.Disconnected);
  const [hasGuest, setHasGuest] = useState(false);
  const normalizedSlot = typeof slotNumber === 'number' && slotNumber >= 1 && slotNumber <= 6 ? slotNumber : 1;
  const gain = typeof channelGain === 'number' && Number.isFinite(channelGain) ? Math.max(0, Math.min(1, channelGain)) : 1;

  useEffect(() => {
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: false });
    const isTarget = (participant: RemoteParticipant) => {
      if (!participant.identity.startsWith('guest-')) return false;
      try {
        const metadata = JSON.parse(participant.metadata || '{}') as {
          slotNumber?: number;
        };
        return metadata.slotNumber === normalizedSlot;
      } catch {
        return false;
      }
    };
    const attach = (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (!isTarget(participant)) return;
      setHasGuest(true);
      if (track.kind === Track.Kind.Video && videoRef.current) track.attach(videoRef.current);
      if (track.kind === Track.Kind.Audio && audioRef.current) track.attach(audioRef.current);
    };
    const refresh = () => {
      const target = Array.from(room.remoteParticipants.values()).find(isTarget);
      setHasGuest(Boolean(target));
      target?.trackPublications.forEach((publication) => {
        if (publication.track) attach(publication.track, publication, target);
      });
    };
    room.on(RoomEvent.ConnectionStateChanged, setConnectionState);
    room.on(RoomEvent.TrackSubscribed, attach);
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (isTarget(participant)) {
        track.detach();
        refresh();
      }
    });
    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);

    const connect = async () => {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const rendererKey = fragment.get('key') || window.sessionStorage.getItem('alcantara-renderer-key') || '';
      if (rendererKey) window.sessionStorage.setItem('alcantara-renderer-key', rendererKey);
      if (!rendererKey) throw new Error('Renderer source credential is missing.');
      const response = await fetch(apiUrl('/webrtc/renderer-source-token'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Renderer-Key': rendererKey
        },
        body: JSON.stringify({ programId })
      });
      if (!response.ok) throw new Error(`Guest source authorization failed (${response.status}).`);
      const credentials = (await response.json()) as {
        serverUrl: string;
        token: string;
      };
      if (cancelled) return;
      await room.connect(credentials.serverUrl, credentials.token, {
        autoSubscribe: true
      });
      if (!cancelled) refresh();
    };
    void connect().catch((error) => {
      console.error('WebRTC guest slot failed:', error);
      if (!cancelled) setConnectionState(ConnectionState.Disconnected);
    });
    return () => {
      cancelled = true;
      room.disconnect();
    };
  }, [normalizedSlot, programId]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = suppressAudio ? 0 : gain;
    audioRef.current.muted = suppressAudio || gain <= 0.0001;
  }, [gain, suppressAudio]);

  return (
    <div className='absolute inset-0 overflow-hidden bg-black'>
      <video ref={videoRef} autoPlay playsInline className='h-full w-full bg-black' style={{ objectFit: objectFit === 'contain' ? 'contain' : 'cover' }} />
      <audio ref={audioRef} autoPlay playsInline muted={suppressAudio || gain <= 0.0001} />
      {showStatus !== false && (connectionState !== ConnectionState.Connected || !hasGuest) ? (
        <div className='absolute inset-0 flex items-center justify-center bg-zinc-950 text-center text-white'>
          <div>
            <div className={`mx-auto mb-3 h-3 w-3 rounded-full ${connectionState === ConnectionState.Connected ? 'bg-amber-400' : 'animate-pulse bg-sky-400'}`} />
            <p className='text-2xl font-semibold'>{connectionState === ConnectionState.Connected ? `Guest slot ${normalizedSlot} offline` : 'Connecting guest source'}</p>
            <p className='mt-2 text-sm text-white/50'>Assignment is retained for the 60-second reconnect window.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
