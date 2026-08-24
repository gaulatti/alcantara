import { LocalAudioTrack, ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { apiUrl } from '../utils/apiBaseUrl';

type RouteState = {
  participantIdentity: string;
  slotNumber: number;
  returnVideo: 'program' | 'preview' | 'none';
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
};

type InputTrack = {
  key: string;
  participantIdentity: string;
  trackName: string;
  source: MediaStreamAudioSourceNode;
};

type PublishedMix = {
  track: LocalAudioTrack;
  destination: MediaStreamAudioDestinationNode;
};

export function meta() {
  return [{ title: 'Return Router - Alcántara' }];
}

function readRendererKey() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const key = fragment.get('key') || window.sessionStorage.getItem('alcantara-renderer-key') || '';
  if (key) window.sessionStorage.setItem('alcantara-renderer-key', key);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return key;
}

export default function ReturnRouterRoute() {
  const { programId = 'main' } = useParams();
  const [status, setStatus] = useState('Starting isolated return router…');
  const [mixCount, setMixCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const rendererKey = readRendererKey();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const context = new AudioContext({ latencyHint: 'interactive' });
    const inputs = new Map<string, InputTrack>();
    const mixes = new Map<string, PublishedMix>();
    let routes: RouteState[] = [];
    let rebuildTimer = 0;
    let stateTimer = 0;

    const unpublishMixes = async () => {
      const pending = Array.from(mixes.values()).map(async (mix) => {
        await room.localParticipant.unpublishTrack(mix.track);
        mix.track.stop();
        mix.destination.disconnect();
      });
      mixes.clear();
      await Promise.all(pending);
    };

    const rebuild = async () => {
      if (cancelled || room.state !== ConnectionState.Connected) return;
      await unpublishMixes();
      inputs.forEach((input) => input.source.disconnect());
      const connectedGuests = new Set(
        Array.from(room.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith('guest-'))
          .map((participant) => participant.identity)
      );
      for (const route of routes.filter((item) => connectedGuests.has(item.participantIdentity))) {
        const destination = context.createMediaStreamDestination();
        for (const input of inputs.values()) {
          const isOwnGuest = input.participantIdentity === route.participantIdentity;
          const isOtherGuest = input.participantIdentity.startsWith('guest-') && !isOwnGuest;
          const isSelectedBus =
            input.participantIdentity === `${route.returnAudioBus}-feed-${programId}` ||
            (route.returnAudioBus === 'master' && input.participantIdentity === `program-feed-${programId}`);
          const isTargetedTalkback =
            input.participantIdentity.startsWith('operator-') &&
            (input.trackName === `talkback:${route.participantIdentity.replace(/^guest-/, '')}` || input.trackName === 'talkback:all');
          if (isSelectedBus || isTargetedTalkback) {
            input.source.connect(destination);
          } else if (isOtherGuest) {
            const sourceRoute = routes.find((candidate) => candidate.participantIdentity === input.participantIdentity);
            if (sourceRoute?.sourceMuted) continue;
            const gain = context.createGain();
            gain.gain.value = sourceRoute?.sourceGain ?? 1;
            const delay = context.createDelay(2);
            delay.delayTime.value = (sourceRoute?.sourceDelayMs ?? 0) / 1000;
            input.source.connect(gain).connect(delay).connect(destination);
          }
        }
        const mediaTrack = destination.stream.getAudioTracks()[0];
        const localTrack = new LocalAudioTrack(mediaTrack);
        await room.localParticipant.publishTrack(localTrack, {
          name: `mixminus:${route.participantIdentity}:${route.returnAudioBus}`,
          source: Track.Source.Microphone
        });
        mixes.set(route.participantIdentity, {
          track: localTrack,
          destination
        });
      }
      if (!cancelled) {
        setMixCount(mixes.size);
        setStatus(`${mixes.size} synchronized N-1 return mix${mixes.size === 1 ? '' : 'es'} active`);
      }
    };

    const scheduleRebuild = () => {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => void rebuild().catch((error) => setStatus(error instanceof Error ? error.message : 'Mix rebuild failed.')), 100);
    };

    const addTrack = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio || !track.mediaStreamTrack) return;
      const key = publication.trackSid;
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      inputs.set(key, {
        key,
        participantIdentity: participant.identity,
        trackName: publication.trackName,
        source
      });
      scheduleRebuild();
    };

    const removeTrack = (_track: RemoteTrack, publication: RemoteTrackPublication) => {
      const input = inputs.get(publication.trackSid);
      input?.source.disconnect();
      inputs.delete(publication.trackSid);
      scheduleRebuild();
    };

    const loadRoutes = async () => {
      const response = await fetch(apiUrl('/webrtc/renderer-state'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Renderer-Key': rendererKey
        },
        body: JSON.stringify({ programId })
      });
      if (!response.ok) throw new Error(`Return routing state failed (${response.status}).`);
      const payload = (await response.json()) as { routes: RouteState[] };
      const changed = JSON.stringify(routes) !== JSON.stringify(payload.routes);
      routes = payload.routes;
      if (changed) scheduleRebuild();
    };

    const start = async () => {
      if (!rendererKey) throw new Error('Renderer bootstrap key is required in the URL fragment.');
      const response = await fetch(apiUrl('/webrtc/renderer-token'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Renderer-Key': rendererKey
        },
        body: JSON.stringify({ programId })
      });
      if (!response.ok) throw new Error(`Renderer authorization failed (${response.status}).`);
      const credentials = (await response.json()) as {
        serverUrl: string;
        token: string;
      };
      room.on(RoomEvent.TrackSubscribed, addTrack);
      room.on(RoomEvent.TrackUnsubscribed, removeTrack);
      room.on(RoomEvent.ParticipantConnected, scheduleRebuild);
      room.on(RoomEvent.ParticipantDisconnected, scheduleRebuild);
      room.on(RoomEvent.Reconnecting, () => setStatus('Reconnecting return router…'));
      room.on(RoomEvent.Reconnected, scheduleRebuild);
      await room.connect(credentials.serverUrl, credentials.token, {
        autoSubscribe: true
      });
      await context.resume();
      await loadRoutes();
      stateTimer = window.setInterval(() => void loadRoutes().catch((error) => setStatus(error instanceof Error ? error.message : 'Route refresh failed.')), 3000);
      scheduleRebuild();
    };

    void start().catch((error) => setStatus(error instanceof Error ? error.message : 'Return router failed.'));
    return () => {
      cancelled = true;
      window.clearTimeout(rebuildTimer);
      window.clearInterval(stateTimer);
      void unpublishMixes();
      inputs.forEach((input) => input.source.disconnect());
      room.disconnect();
      void context.close();
    };
  }, [programId]);

  return (
    <main className='flex min-h-screen items-center justify-center bg-zinc-950 p-8 text-white'>
      <div className='max-w-xl text-center'>
        <div className={`mx-auto h-4 w-4 rounded-full ${mixCount ? 'bg-emerald-400' : 'animate-pulse bg-amber-300'}`} />
        <h1 className='mt-5 text-2xl font-semibold'>Alcántara return router</h1>
        <p className='mt-3 text-white/60'>{status}</p>
        <p className='mt-6 text-xs text-white/35'>
          This machine-only page produces a distinct Program/Monitor/Aux N-1 mix for every connected guest. Keep it isolated with the Alana renderer.
        </p>
      </div>
    </main>
  );
}
