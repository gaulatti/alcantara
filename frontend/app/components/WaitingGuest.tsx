import { Button } from '@gaulatti/bleecker';
import { Room, RoomEvent, Track, createLocalAudioTrack, type RemoteTrack } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { authFetch } from '../services/api';
import { holdLocalAudio } from '../utils/localAudio';
import { useHostMic } from './HostMicOnAir';
import { usePreFadeMuted } from './LocalAudioGuard';

/**
 * A guest who has joined and is not yet admitted. They are in a room of their own: Talk opens a private two-way link
 * (see and hear them, speak to them), none of it on air. Admit puts them on their strip; Decline turns them away.
 */
export function WaitingGuest({
  invitationId,
  name,
  slot,
  canOperate,
  busy,
  onAdmit,
  onDecline
}: {
  invitationId: string;
  name: string;
  slot: number;
  canOperate: boolean;
  busy: boolean;
  onAdmit: () => void;
  onDecline: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The open link, or the attempt that is still connecting; replaced or cleared to cancel it.
  const linkRef = useRef<{ room: Room; track: { stop: () => void } | null } | null>(null);
  // Their voice is held with the pre-listens: muted while the host microphone is open without headphones (#879).
  const release = useRef<(() => void) | null>(null);
  const hostMic = useHostMic();
  const micLive = hostMic !== null && hostMic.state !== 'off';
  const muted = usePreFadeMuted();
  const [talking, setTalking] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    const link = linkRef.current;
    linkRef.current = null;
    release.current?.();
    release.current = null;
    link?.track?.stop();
    link?.room.disconnect();
    setTalking(false);
  };
  // Leaving the list (admitted, declined, gone) or the page closes the microphone.
  useEffect(() => close, []);

  const talk = async () => {
    setError('');
    setTalking(true);
    const link: { room: Room; track: { stop: () => void } | null } = { room: new Room(), track: null };
    linkRef.current = link;
    try {
      const response = await authFetch(`/webrtc/invitations/${encodeURIComponent(invitationId)}/screening-token`, { method: 'POST' });
      if (!response.ok) throw new Error('The private link could not be opened.');
      const credentials = (await response.json()) as { serverUrl: string; token: string };
      link.room.on(RoomEvent.TrackSubscribed, (remote: RemoteTrack) => {
        const element = remote.kind === Track.Kind.Video ? videoRef.current : audioRef.current;
        if (!element) return;
        remote.attach(element);
        // After attach, which sets the element's own mute.
        if (remote.kind !== Track.Kind.Video) {
          release.current?.();
          release.current = holdLocalAudio(element);
        }
      });
      await link.room.connect(credentials.serverUrl, credentials.token);
      const microphone = await createLocalAudioTrack();
      // Closed while connecting: the microphone must not stay open.
      if (linkRef.current !== link) {
        microphone.stop();
        link.room.disconnect();
        return;
      }
      link.track = microphone;
      await link.room.localParticipant.publishTrack(microphone, { name: `talkback:${invitationId}` });
    } catch (reason) {
      if (linkRef.current !== link) return;
      close();
      setError(reason instanceof Error ? reason.message : 'The private link could not be opened.');
    }
  };

  return (
    <li className='space-y-2'>
      <div>
        <strong>{name}</strong>
        <span className='block text-xs text-amber-300'>Slot {slot} · waiting to be let in · not on air</span>
      </div>
      {talking ? (
        <div>
          <video ref={videoRef} autoPlay playsInline muted aria-label={`${name}, off air`} className='aspect-video w-full rounded-lg bg-black object-cover' />
          <audio ref={audioRef} autoPlay />
          <p className='mt-1 text-xs text-text-secondary'>Private: you see and hear {name}, and your microphone goes only to them.</p>
          {micLive ? (
            <p role='status' className='text-xs text-accent-yellow'>
              {muted ? `PFL muted · your mic is live, so ${name} is not played aloud` : 'PFL on headphones'}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role='alert' className='text-xs text-terracotta'>
          {error}
        </p>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' disabled={!canOperate || busy} onClick={onAdmit} aria-label={`Admit ${name}`}>
          Admit
        </Button>
        <Button size='sm' variant='secondary' disabled={!canOperate} onClick={() => (talking ? close() : void talk())} aria-pressed={talking} aria-label={`Talk to ${name} privately`}>
          {talking ? 'End private talk' : 'Talk privately'}
        </Button>
        <Button size='sm' variant='destructive' disabled={!canOperate || busy} onClick={onDecline} aria-label={`Decline ${name}`}>
          Decline
        </Button>
      </div>
    </li>
  );
}
