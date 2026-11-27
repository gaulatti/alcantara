import { Button } from '@gaulatti/bleecker';
import { Mic, MicOff } from 'lucide-react';
import { createLocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { authFetch } from '../services/api';

/**
 * The host's own microphone on air (gaulatti/alcantara calls): published into the program's call room as
 * `onair:host`, which the station's contribution worker puts on air and the return router plays to every guest. Off
 * by default; switching it off, leaving the console or losing the room unpublishes it. Talkback stays separate and
 * never reaches air.
 *
 * The microphone belongs to the console, not to a page (gaulatti/alcantara#879): under HostMicProvider it stays live
 * while the operator moves between pages, and goes off when they switch shows.
 */
function useHostMicController() {
  const [state, setState] = useState<'off' | 'starting' | 'on'>('off');
  const [error, setError] = useState('');
  // The show the microphone was opened for.
  const [programId, setProgramId] = useState<string | null>(null);
  const link = useRef<{ room: Room; track: { stop: () => void } | null } | null>(null);

  const close = () => {
    const current = link.current;
    link.current = null;
    current?.track?.stop();
    current?.room.disconnect();
  };
  useEffect(() => close, []);

  const stop = (reason = '') => {
    close();
    setState('off');
    setError(reason);
  };

  const start = async (programId: string) => {
    // One microphone: a press while one is open or opening changes nothing.
    if (link.current) return;
    setProgramId(programId);
    setError('');
    setState('starting');
    const current: { room: Room; track: { stop: () => void } | null } = { room: new Room(), track: null };
    link.current = current;
    try {
      const response = await authFetch('/webrtc/operator-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId })
      });
      if (!response.ok) throw new Error('The host microphone could not join the call room.');
      const credentials = (await response.json()) as { serverUrl: string; token: string };
      // The studio can mute the published microphone on the server (the operator's Mic off action). That takes it off
      // air whatever the page does, so the page follows: the track is stopped, the room left and the button shows off.
      current.room.on(RoomEvent.TrackMuted, (publication: { source: Track.Source; isMuted: boolean }, participant: { isLocal: boolean }) => {
        if (link.current !== current) return;
        if (!participant.isLocal || publication.source !== Track.Source.Microphone || !publication.isMuted) return;
        close();
        setState('off');
        setError('The studio muted the host microphone. It is off air.');
      });
      current.room.on(RoomEvent.Disconnected, () => {
        if (link.current !== current) return;
        link.current = null;
        current.track?.stop();
        setState('off');
        setError('The host microphone left the air: the call room closed.');
      });
      await current.room.connect(credentials.serverUrl, credentials.token);
      const microphone = await createLocalAudioTrack();
      if (link.current !== current) {
        microphone.stop();
        current.room.disconnect();
        return;
      }
      current.track = microphone;
      // Only the station's contribution worker (air) and the return router (guests' returns) may receive it.
      current.room.localParticipant.setTrackSubscriptionPermissions(false, [
        { participantIdentity: `contribution-${programId}`, allowAll: true },
        { participantIdentity: `return-router-${programId}`, allowAll: true }
      ]);
      await current.room.localParticipant.publishTrack(microphone, { name: 'onair:host' });
      setState('on');
    } catch (reason) {
      if (link.current !== current) return;
      close();
      setState('off');
      setError(reason instanceof Error ? reason.message : 'The host microphone could not go on air.');
    }
  };

  const dismissError = () => setError('');

  return { state, error, programId, start, stop, dismissError };
}

type HostMic = ReturnType<typeof useHostMicController>;
const HostMicContext = createContext<HostMic | null>(null);

/** The console's one microphone, above the pages. `programId` is the show selected in the header. */
export function HostMicProvider({ programId, children }: { programId: string; children: ReactNode }) {
  const mic = useHostMicController();
  const opened = mic.state === 'off' ? null : mic.programId;
  useEffect(() => {
    // Never on air for a show the console is no longer showing.
    if (opened !== null && opened !== programId) mic.stop('The microphone was switched off because the show changed.');
  }, [opened, programId]);
  return <HostMicContext.Provider value={mic}>{children}</HostMicContext.Provider>;
}

export const useHostMic = () => useContext(HostMicContext);

/** The button, from the console's microphone when there is one; on its own (a page outside the console) otherwise. */
export function HostMicOnAir({ programId, canOperate }: { programId: string; canOperate: boolean }) {
  const shared = useHostMic();
  const own = useHostMicController();
  const mic = shared ?? own;
  const { state, error } = mic;
  const stop = () => mic.stop();
  const start = () => mic.start(programId);

  return (
    <span className='host-mic-on-air' data-on-air={state === 'on'}>
      {state === 'on' ? (
        <Button size='sm' variant='destructive' aria-pressed onClick={stop}>
          <Mic size={14} /> ON AIR · Mic on air
        </Button>
      ) : (
        <Button size='sm' variant='secondary' aria-pressed={false} disabled={!canOperate} loading={state === 'starting'} onClick={() => void start()}>
          <MicOff size={14} /> Mic on air
        </Button>
      )}
      {error ? (
        <span role='alert' className='text-xs text-terracotta'>
          {error}
        </span>
      ) : null}
    </span>
  );
}
