import { LocalAudioTrack, ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { apiUrl } from '../utils/apiBaseUrl';
import { isProgramFeed, preferredProgramFeed } from '../utils/programFeed';

type RouteState = {
  participantIdentity: string;
  slotNumber: number;
  returnVideo: 'program' | 'preview' | 'none';
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
  /** Cued live in the guest's current session (absent from an older backend: off air). */
  onAir?: boolean;
};

type InputTrack = {
  key: string;
  participantIdentity: string;
  trackName: string;
  source: MediaStreamAudioSourceNode;
  /** Chromium leaves a remote WebRTC track silent in Web Audio unless a media element also plays it (muted is enough). */
  keepAlive: HTMLAudioElement;
};

function releaseInput(input: InputTrack) {
  input.source.disconnect();
  input.keepAlive.pause();
  input.keepAlive.srcObject = null;
}

type PublishedMix = {
  /** The published track's name, `mixminus:<guest>:<bus>`: a mix is kept while the guest stays on that bus. */
  name: string;
  /** Level and delay stages built for this mix at the last rebuild, let go at the next. */
  stages: AudioNode[];
  track: LocalAudioTrack;
  destination: MediaStreamAudioDestinationNode;
  /** Listens to the published track itself, for the levels line. */
  meter: AnalyserNode;
  metered: MediaStreamAudioSourceNode;
};

export function meta() {
  return [{ title: 'Return Router - Alcántara' }];
}

/**
 * The host's microphone on air: `onair:host` from the program's one host-mic identity only (gaulatti/alcantara#879).
 * LiveKit admits that identity once at a time, so guests hear one host microphone, and an `onair:host` from any other
 * operator connection is not mixed in.
 */
export function isHostMic(input: { participantIdentity: string; trackName: string }, programId: string): boolean {
  return input.participantIdentity === `operator-host-mic-${programId}` && input.trackName === 'onair:host';
}

function readRendererKey() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const key = fragment.get('key') || window.sessionStorage.getItem('alcantara-renderer-key') || '';
  if (key) window.sessionStorage.setItem('alcantara-renderer-key', key);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return key;
}

/** Retry delays for the program-audio fallback: a dropped stream is asked for again, then less often. */
const PROGRAM_AUDIO_RETRY_MS = [5_000, 15_000, 60_000];

/** How often the page reports its levels for the runner's log. */
const LEVELS_EVERY_MS = 10_000;

/**
 * One bounded line for the runner's log: a fixed prefix, then codes and numbers only (never a key, a URL or a
 * token). The runner forwards these lines, and only these, to its stdout.
 */
function diagnose(message: string) {
  console.info(`[return-router] ${message}`);
}

/** The peak of what an analyser hears right now, 0 to 1. */
function peakOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
  return Math.round(peak * 1000) / 1000;
}

/** Tells a supervising runner how the page is doing: `starting`, `connected` or `failed`, plus the live mix count. */
function reportState(state: 'starting' | 'connected' | 'failed', mixCount?: number) {
  const root = document.documentElement;
  root.dataset.returnRouter = state;
  if (mixCount !== undefined) root.dataset.mixCount = String(mixCount);
}

/** A short, fixed message with a code. The raw error text is never shown (gaulatti/alcantara#353). */
function boundedProblem(code: string, message: string): string {
  return `${message} (${code})`;
}

export default function ReturnRouterRoute() {
  const { programId = 'main' } = useParams();
  const [status, setStatus] = useState('Starting isolated return router…');
  // A failure is shown beside the last good status, never in its place (gaulatti/alcantara#353).
  const [problem, setProblem] = useState<string | null>(null);
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
    let programAudioTimer = 0;
    let programAudioFailures = 0;
    // The program's own audio (Palazzo's output, through the backend's grant), mixed in as the program bus when no
    // program feed is in the room. Without it a guest hears nothing unless the desktop Feed or Alana is publishing.
    let programAudio: { element: HTMLAudioElement; source: MediaElementAudioSourceNode; meter: AnalyserNode } | null = null;
    let levelsTimer = 0;
    let lastContextState = '';
    const meterBuffer = new Float32Array(2048);
    // An AudioContext created without a gesture can start suspended, and a suspended context makes every mix
    // silent, so it is asked to run on every rebuild and on every levels tick.
    const keepContextRunning = () => {
      if (context.state !== lastContextState) {
        lastContextState = context.state;
        diagnose(`context ${context.state}`);
      }
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
    };
    // The server-run router (opened by the return runner with `?runner=1`) takes the program's one fixed identity.
    const runner = new URLSearchParams(window.location.search).get('runner') === '1';
    reportState('starting', 0);

    const releaseMix = async (key: string, mix: PublishedMix) => {
      mixes.delete(key);
      mix.stages.forEach((stage) => stage.disconnect());
      await room.localParticipant.unpublishTrack(mix.track);
      mix.track.stop();
      mix.destination.disconnect();
      mix.metered.disconnect();
    };

    const unpublishMixes = async () => {
      await Promise.all(Array.from(mixes.entries()).map(([key, mix]) => releaseMix(key, mix)));
    };

    const rebuild = async () => {
      if (cancelled || room.state !== ConnectionState.Connected) return;
      keepContextRunning();
      // Each guest keeps one published track for as long as they stay on the same bus: a rebuild rewires the audio
      // graph behind it and never replaces the track, so the guest's return plays on without a gap.
      inputs.forEach((input) => input.source.disconnect());
      if (programAudio) {
        programAudio.source.disconnect();
        programAudio.source.connect(programAudio.meter);
      }
      for (const mix of mixes.values()) {
        mix.stages.forEach((stage) => stage.disconnect());
        mix.stages = [];
      }
      const connectedGuests = new Set(
        Array.from(room.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith('guest-'))
          .map((participant) => participant.identity)
      );
      const programFeedsWithAudio = new Set(
        Array.from(inputs.values())
          .map((input) => input.participantIdentity)
          .filter((identity) => isProgramFeed(identity, programId))
      );
      // While anyone is on air (a connected guest cued live, or the host's `onair:host` mic) the program bed carries
      // their voices a few seconds late, so it leaves every return: guests hear each other and the host in real
      // time through the room instead (mix-minus by muting the late program bed).
      const hostOnAir = Array.from(inputs.values()).some((input) => isHostMic(input, programId));
      const anyoneOnAir = hostOnAir || routes.some((route) => route.onAir === true && connectedGuests.has(route.participantIdentity));
      const wanted = routes.filter((item) => connectedGuests.has(item.participantIdentity));
      const wantedNames = new Map(wanted.map((route) => [route.participantIdentity, `mixminus:${route.participantIdentity}:${route.returnAudioBus}`]));
      await Promise.all(
        Array.from(mixes.entries())
          .filter(([key, mix]) => wantedNames.get(key) !== mix.name)
          .map(([key, mix]) => releaseMix(key, mix))
      );
      for (const route of wanted) {
        const name = wantedNames.get(route.participantIdentity)!;
        let mix = mixes.get(route.participantIdentity);
        if (!mix) {
          const created = context.createMediaStreamDestination();
          const meter = context.createAnalyser();
          meter.fftSize = 2048;
          const metered = context.createMediaStreamSource(created.stream);
          metered.connect(meter);
          const track = new LocalAudioTrack(created.stream.getAudioTracks()[0]);
          try {
            await room.localParticipant.publishTrack(track, { name, source: Track.Source.Microphone });
          } catch (error) {
            // Not kept: the next rebuild publishes it again.
            track.stop();
            metered.disconnect();
            created.disconnect();
            throw error;
          }
          mix = { name, stages: [], track, destination: created, meter, metered };
          mixes.set(route.participantIdentity, mix);
        }
        const { destination } = mix;
        for (const input of inputs.values()) {
          const isOwnGuest = input.participantIdentity === route.participantIdentity;
          const isOtherGuest = input.participantIdentity.startsWith('guest-') && !isOwnGuest;
          // The program bus comes from one feed only: the desktop's when it is in the
          // room, otherwise Alana's (gaulatti/alexandria#9), never both at once.
          const programBus = route.returnAudioBus === 'master' || route.returnAudioBus === 'program';
          const isSelectedBus = programBus
            ? input.participantIdentity === preferredProgramFeed(programId, programFeedsWithAudio)
            : input.participantIdentity === `${route.returnAudioBus}-feed-${programId}`;
          const isHost = isHostMic(input, programId);
          const isTargetedTalkback =
            input.participantIdentity.startsWith('operator-') &&
            (input.trackName === `talkback:${route.participantIdentity.replace(/^guest-/, '')}` || input.trackName === 'talkback:all');
          if ((isSelectedBus && !(programBus && anyoneOnAir)) || isTargetedTalkback || isHost) {
            input.source.connect(destination);
          } else if (isOtherGuest) {
            const sourceRoute = routes.find((candidate) => candidate.participantIdentity === input.participantIdentity);
            if (sourceRoute?.sourceMuted) continue;
            const gain = context.createGain();
            gain.gain.value = sourceRoute?.sourceGain ?? 1;
            const delay = context.createDelay(2);
            delay.delayTime.value = (sourceRoute?.sourceDelayMs ?? 0) / 1000;
            input.source.connect(gain).connect(delay).connect(destination);
            mix.stages.push(gain, delay);
          }
        }
        // No program feed carries audio: the program bus is the program's own audio, when the program has it.
        const programBus = route.returnAudioBus === 'master' || route.returnAudioBus === 'program';
        if (programBus && !anyoneOnAir && programFeedsWithAudio.size === 0 && programAudio) programAudio.source.connect(destination);
      }
      if (!cancelled) {
        setMixCount(mixes.size);
        reportState('connected', mixes.size);
        setProblem(null);
        setStatus(`${mixes.size} synchronized N-1 return mix${mixes.size === 1 ? '' : 'es'} active`);
      }
    };

    const scheduleRebuild = () => {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => void rebuild().catch(() => setProblem(boundedProblem('mix_rebuild', 'The mix could not be rebuilt. It retries when the room changes.'))), 100);
    };

    const addTrack = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio || !track.mediaStreamTrack) return;
      const key = publication.trackSid;
      const stream = new MediaStream([track.mediaStreamTrack]);
      const source = context.createMediaStreamSource(stream);
      const keepAlive = new Audio();
      keepAlive.muted = true;
      keepAlive.srcObject = stream;
      void Promise.resolve(keepAlive.play()).catch(() => undefined);
      inputs.get(key)?.keepAlive.pause();
      inputs.set(key, {
        key,
        participantIdentity: participant.identity,
        trackName: publication.trackName,
        source,
        keepAlive
      });
      scheduleRebuild();
    };

    const removeTrack = (_track: RemoteTrack, publication: RemoteTrackPublication) => {
      const input = inputs.get(publication.trackSid);
      if (input) releaseInput(input);
      inputs.delete(publication.trackSid);
      scheduleRebuild();
    };

    const retryProgramAudio = () => {
      if (cancelled) return;
      const delay = PROGRAM_AUDIO_RETRY_MS[Math.min(programAudioFailures, PROGRAM_AUDIO_RETRY_MS.length - 1)];
      programAudioFailures += 1;
      window.clearTimeout(programAudioTimer);
      programAudioTimer = window.setTimeout(() => void startProgramAudio(), delay);
    };

    const stopProgramAudio = () => {
      if (!programAudio) return;
      programAudio.source.disconnect();
      programAudio.meter.disconnect();
      programAudio.element.pause();
      programAudio.element.removeAttribute('src');
      programAudio.element.load();
      programAudio = null;
    };

    const startProgramAudio = async () => {
      if (cancelled) return;
      diagnose('program-audio requested');
      try {
        const response = await fetch(apiUrl('/webrtc/return-audio-ticket'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Renderer-Key': rendererKey },
          body: JSON.stringify({ programId })
        });
        if (!response.ok) throw new Error(`ticket_${response.status}`);
        const grant = (await response.json()) as { streamPath?: unknown };
        if (typeof grant.streamPath !== 'string' || !grant.streamPath.startsWith('/radio/')) throw new Error('grant_malformed');
        if (cancelled) return;
        stopProgramAudio();
        const element = new Audio();
        element.crossOrigin = 'anonymous';
        element.preload = 'none';
        const source = context.createMediaElementSource(element);
        const meter = context.createAnalyser();
        meter.fftSize = 2048;
        source.connect(meter);
        programAudio = { element, source, meter };
        element.addEventListener('playing', () => {
          programAudioFailures = 0;
          diagnose('program-audio playing');
        });
        const dropped = (event: Event) => {
          if (programAudio?.element !== element) return;
          diagnose(`program-audio failed code=${event.type === 'ended' ? 'ended' : `media_${element.error?.code ?? 0}`}`);
          stopProgramAudio();
          scheduleRebuild();
          retryProgramAudio();
        };
        element.addEventListener('error', dropped);
        element.addEventListener('ended', dropped);
        element.src = apiUrl(grant.streamPath);
        await element.play().catch(() => {
          throw new Error('play_refused');
        });
        scheduleRebuild();
      } catch (error) {
        const code = error instanceof Error && /^(ticket_\d+|grant_malformed|play_refused)$/.test(error.message) ? error.message : 'unavailable';
        diagnose(`program-audio failed code=${code}`);
        // No radio connection, or the stream dropped: the program feeds still apply, and it is asked for again.
        stopProgramAudio();
        retryProgramAudio();
      }
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
        body: JSON.stringify(runner ? { programId, role: 'return-router' } : { programId })
      });
      if (!response.ok) throw new Error(`Renderer authorization failed (${response.status}).`);
      const credentials = (await response.json()) as {
        serverUrl: string;
        token: string;
      };
      // A page unmounted before it connected (React's development double mount) must not join: with the fixed
      // identity the two copies would replace each other in LiveKit.
      if (cancelled) return;
      room.on(RoomEvent.TrackSubscribed, addTrack);
      room.on(RoomEvent.TrackUnsubscribed, removeTrack);
      room.on(RoomEvent.ParticipantConnected, scheduleRebuild);
      room.on(RoomEvent.ParticipantDisconnected, scheduleRebuild);
      room.on(RoomEvent.Reconnecting, () => {
        setProblem(null);
        setStatus('Reconnecting return router…');
      });
      room.on(RoomEvent.Reconnected, scheduleRebuild);
      // Replaced by another router with the same identity, or the server ended the session: the runner reopens it.
      room.on(RoomEvent.Disconnected, () => {
        if (!cancelled) reportState('failed');
      });
      await room.connect(credentials.serverUrl, credentials.token, {
        autoSubscribe: true
      });
      await context.resume();
      await loadRoutes();
      void startProgramAudio();
      keepContextRunning();
      levelsTimer = window.setInterval(() => {
        keepContextRunning();
        const program = programAudio ? String(peakOf(programAudio.meter, meterBuffer)) : 'none';
        const mixPeak = Array.from(mixes.values()).reduce((peak, mix) => Math.max(peak, peakOf(mix.meter, meterBuffer)), 0);
        diagnose(`levels program=${program} mixes=${mixes.size} mixpeak=${mixPeak}`);
      }, LEVELS_EVERY_MS);
      stateTimer = window.setInterval(() => void loadRoutes().catch(() => setProblem(boundedProblem('route_refresh', 'Route refresh failed; the last routes still apply.'))), 3000);
      scheduleRebuild();
    };

    void start().catch(() => {
      reportState('failed');
      setStatus(boundedProblem('start', 'The return router could not start. Reload this page to try again.'));
    });
    return () => {
      cancelled = true;
      window.clearTimeout(rebuildTimer);
      window.clearInterval(stateTimer);
      window.clearTimeout(programAudioTimer);
      window.clearInterval(levelsTimer);
      stopProgramAudio();
      void unpublishMixes();
      inputs.forEach(releaseInput);
      room.disconnect();
      void context.close();
    };
  }, [programId]);

  return (
    <main className='flex min-h-screen items-center justify-center bg-zinc-950 p-8 text-white'>
      <div className='max-w-xl text-center'>
        <div className={`mx-auto h-4 w-4 rounded-full ${mixCount ? 'bg-emerald-400' : 'animate-pulse bg-amber-300'}`} />
        <h1 className='mt-5 text-2xl font-semibold'>Alcántara return router</h1>
        <p role='status' aria-live='polite' className='mt-3 text-white/60'>{status}</p>
        {problem ? (
          <p role='alert' className='mt-2 text-sm text-amber-200'>
            {problem}
          </p>
        ) : null}
        <p className='mt-6 text-xs text-white/35'>
          This machine-only page produces a distinct Program/Monitor/Aux N-1 mix for every connected guest. The return runner opens it for every program with a guest on a call; nobody needs to open it by hand.
        </p>
      </div>
    </main>
  );
}
