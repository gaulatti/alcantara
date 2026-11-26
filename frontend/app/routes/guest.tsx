import { TooltipButton } from "../components/BleeckerButtons";
import { Button, Checkbox, Field, Select, StatusBadge } from '@gaulatti/bleecker';
import { Camera, CameraOff, CheckCircle2, Headphones, Mic, MicOff, PhoneOff, Radio, Volume2 } from 'lucide-react';
import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { isDrop, reportJoinFailure, roomIcePath } from '../utils/callTelemetry';
import { isProgramFeed, preferredProgramFeed } from '../utils/programFeed';
import { apiUrl } from '../utils/apiBaseUrl';
import type { Route } from './+types/guest';

type GuestStatus = 'preflight' | 'ready' | 'joining' | 'live' | 'reconnecting' | 'left' | 'ended' | 'error';
type DirectorCommand = {
  id: string;
  type: 'media' | 'cue' | 'message' | 'return';
  device?: 'camera' | 'microphone';
  enabled?: boolean;
  cue?: string;
  text?: string;
  returnVideo?: string;
  returnAudioBus?: string;
};

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Guest Call - Alcántara' }];
}

async function responseError(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message || body;
  } catch {
    return body || `Request failed (${response.status})`;
  }
}

const INVITATION_CLOSED_HINT = 'Ask the studio for a new link.';
const IN_USE_ELSEWHERE = 'This invitation is already in use in another window. Try again in a minute.';
const STUDIO_NOT_READY = 'The studio is not ready for guests yet. Try again in a minute.';
const STUDIO_UNREACHABLE = 'The studio could not be reached. Check your connection and try again.';
const CONNECT_FAILED = 'Could not connect to the studio. Try again.';

export default function GuestRoute() {
  const { invitation = '' } = useParams();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const returnVideoRef = useRef<HTMLVideoElement | null>(null);
  const returnAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const sessionTokenRef = useRef('');
  const heartbeatRef = useRef<number | null>(null);
  // Set at each join until a heartbeat has told the studio, so one join is counted once.
  const announceJoinRef = useRef(false);
  // A lost call is reported by the next heartbeat that gets through.
  const pendingDropRef = useRef(false);
  const [status, setStatus] = useState<GuestStatus>('preflight');
  const [error, setError] = useState('');
  // The join was refused (401/403): the invitation is closed, so a rejoin cannot succeed (gaulatti/alcantara#353).
  const [invitationClosed, setInvitationClosed] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [echoRiskAccepted, setEchoRiskAccepted] = useState(false);
  const [speakerChecked, setSpeakerChecked] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');
  const [network, setNetwork] = useState('Checking network…');
  const [quality, setQuality] = useState('unknown');
  const [returnFeed, setReturnFeed] = useState(false);
  const [displayName, setDisplayName] = useState('Guest');
  const [programId, setProgramId] = useState('');
  const [returnVideo, setReturnVideo] = useState('program');
  const [returnAudioBus, setReturnAudioBus] = useState('master');
  const [notice, setNotice] = useState<DirectorCommand | null>(null);
  // The heartbeat is scheduled once per join, so it reads the call through this ref, kept current on every
  // render: each heartbeat reports the call as it is, not as it was at join (gaulatti/alcantara#672).
  const telemetryRef = useRef({ quality, returnFeed, cameraEnabled, microphoneEnabled });
  telemetryRef.current = { quality, returnFeed, cameraEnabled, microphoneEnabled };

  const stopHeartbeat = () => {
    if (heartbeatRef.current !== null) window.clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
  };

  const heartbeat = async () => {
    if (!sessionTokenRef.current) return;
    const telemetry = telemetryRef.current;
    const icePath = await roomIcePath(roomRef.current);
    const joined = announceJoinRef.current;
    announceJoinRef.current = false;
    const dropped = pendingDropRef.current;
    const response = await fetch(apiUrl('/webrtc/session/heartbeat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: sessionTokenRef.current,
        telemetry: {
          connectionState: roomRef.current?.state ?? 'disconnected',
          quality: telemetry.quality,
          returnFeedHealth: telemetry.returnFeed ? 'healthy' : 'missing',
          cameraEnabled: telemetry.cameraEnabled,
          microphoneEnabled: telemetry.microphoneEnabled,
          ...(icePath ? { iceTransport: icePath } : {}),
          ...(joined ? { joined: true } : {}),
          ...(dropped ? { dropped: true } : {})
        }
      })
    });
    if (response.ok && dropped) pendingDropRef.current = false;
    if (response.status === 401 || response.status === 403) {
      stopHeartbeat();
      roomRef.current?.disconnect();
      setStatus('ended');
      setError('The studio ended or revoked this guest session.');
    }
  };

  const acknowledge = async (command: DirectorCommand, commandStatus: 'accepted' | 'rejected' | 'read' | 'acknowledged') => {
    // Without a session token no receipt can be sent, but the guest's own answer still clears the notice.
    if (sessionTokenRef.current) {
      await fetch(apiUrl(`/webrtc/commands/${encodeURIComponent(command.id)}/ack`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken: sessionTokenRef.current,
          status: commandStatus
        })
      });
    }
    // Only the guest's own answer clears the notice; the automatic 'read' receipt
    // leaves a director message on screen until the guest acknowledges it.
    if (commandStatus === 'acknowledged' || commandStatus === 'accepted') setNotice(null);
  };

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = stream;
        if (previewRef.current) previewRef.current.srcObject = stream;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameraDevices = devices.filter((device) => device.kind === 'videoinput');
        const microphoneDevices = devices.filter((device) => device.kind === 'audioinput');
        setCameras(cameraDevices);
        setMicrophones(microphoneDevices);
        setCameraId(stream.getVideoTracks()[0]?.getSettings().deviceId || cameraDevices[0]?.deviceId || '');
        setMicrophoneId(stream.getAudioTracks()[0]?.getSettings().deviceId || microphoneDevices[0]?.deviceId || '');
        const connection = (
          navigator as Navigator & {
            connection?: {
              effectiveType?: string;
              downlink?: number;
              rtt?: number;
            };
          }
        ).connection;
        setNetwork(connection ? `${connection.effectiveType || 'network'} · ${connection.downlink || '?'} Mbps · ${connection.rtt || '?'} ms RTT` : 'Browser network check ready');
        setStatus('ready');
      } catch (reason) {
        if (!cancelled) void reportJoinFailure(invitation, reason);
        setError(reason instanceof Error ? `Camera or microphone permission failed: ${reason.message}` : 'Camera or microphone permission failed.');
        setStatus('error');
      }
    };
    void prepare();
    return () => {
      cancelled = true;
      stopHeartbeat();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      roomRef.current?.disconnect();
    };
  }, []);

  const switchDevice = async (kind: 'videoinput' | 'audioinput', id: string) => {
    if (kind === 'videoinput') setCameraId(id);
    else setMicrophoneId(id);
    if (roomRef.current?.state === ConnectionState.Connected) {
      await roomRef.current.switchActiveDevice(kind, id);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: kind === 'videoinput' ? { deviceId: { exact: id } } : cameraId ? { deviceId: { exact: cameraId } } : true,
      audio: kind === 'audioinput' ? { deviceId: { exact: id }, echoCancellation: true } : microphoneId ? { deviceId: { exact: microphoneId }, echoCancellation: true } : true
    });
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = stream;
    stream.getVideoTracks().forEach((track) => {
      track.enabled = cameraEnabled;
    });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = microphoneEnabled;
    });
    if (previewRef.current) previewRef.current.srcObject = stream;
  };

  const playSpeakerTest = async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 523.25;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.addEventListener('ended', () => void context.close());
    setSpeakerChecked(true);
  };

  const join = async () => {
    if (!speakerChecked || (!headphonesConfirmed && !echoRiskAccepted)) return;
    setStatus('joining');
    setError('');
    const storageKey = `alcantara-guest-session:${invitation.split('.')[0] || 'unknown'}`;
    const previousSession = window.sessionStorage.getItem(storageKey);
    let response: Response;
    try {
      response = await fetch(apiUrl('/webrtc/join'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitation, sessionToken: previousSession })
      });
    } catch {
      setError(STUDIO_UNREACHABLE);
      setStatus('ready');
      return;
    }
    if (!response.ok) {
      // Revoked, expired or invalid: the same end as a refused heartbeat.
      if (response.status === 401 || response.status === 403) {
        // A rejoin with a revoked or expired invitation: say what to do, not the server's text (gaulatti/alcantara#353).
        setError(`${await responseError(response)} ${INVITATION_CLOSED_HINT}`);
        setInvitationClosed(true);
        setStatus('ended');
        return;
      }
      // Any other refusal can be retried while the preflight checks still hold.
      setError(response.status === 409 ? IN_USE_ELSEWHERE : response.status === 503 ? STUDIO_NOT_READY : await responseError(response));
      setStatus('ready');
      return;
    }
    try {
      const credentials = (await response.json()) as {
        serverUrl: string;
        token: string;
        sessionToken: string;
        displayName: string;
        programId: string;
        participantIdentity: string;
        returnVideo: string;
        returnAudioBus: string;
      };
      window.sessionStorage.setItem(storageKey, credentials.sessionToken);
      sessionTokenRef.current = credentials.sessionToken;
      setDisplayName(credentials.displayName);
      setProgramId(credentials.programId);
      setReturnVideo(credentials.returnVideo);
      setReturnAudioBus(credentials.returnAudioBus);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true
      });
      roomRef.current = room;
      // A new room has no return feed and no quality reading yet: a rejoin does not report the last room's.
      setReturnFeed(false);
      setQuality('unknown');
      telemetryRef.current = { ...telemetryRef.current, returnFeed: false, quality: 'unknown' };
      const programReturn = credentials.returnVideo === 'program';
      const wantedParticipant = (participant: RemoteParticipant) =>
        isProgramFeed(participant.identity, credentials.programId) ||
        participant.identity === `preview-feed-${credentials.programId}` ||
        participant.identity.startsWith('return-router-');
      const wantedTrack = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!wantedParticipant(participant)) return false;
        if (publication.kind === Track.Kind.Video) {
          if (credentials.returnVideo === 'none') return false;
          // Both program feeds are kept subscribed so the switch between them is
          // a re-attach; an unattached video track is paused (adaptive stream).
          if (programReturn) return isProgramFeed(participant.identity, credentials.programId);
          return participant.identity === `${credentials.returnVideo}-feed-${credentials.programId}`;
        }
        return publication.trackName === `mixminus:${credentials.participantIdentity}:${credentials.returnAudioBus}`;
      };
      const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        void publication.setSubscribed(wantedTrack(publication, participant));
      };
      // The program video on screen, and the program feeds' video tracks by identity
      // (gaulatti/alexandria#9: the desktop's feed when present, otherwise Alana's).
      const programTracks = new Map<string, RemoteTrack>();
      let shownVideo: RemoteTrack | null = null;
      const show = (next: RemoteTrack | null) => {
        if (next === shownVideo) return;
        // Attach the new track before detaching the old one, so the switch shows
        // no black longer than the handover itself.
        if (next && returnVideoRef.current) next.attach(returnVideoRef.current);
        shownVideo?.detach();
        shownVideo = next;
        setReturnFeed(next !== null);
      };
      const showPreferredProgram = () => {
        if (!programReturn) return;
        const present = [...programTracks.keys()];
        const preferred = programTracks.get(preferredProgramFeed(credentials.programId, present));
        show(preferred ?? programTracks.values().next().value ?? null);
      };
      const attach = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!wantedTrack(publication, participant)) return;
        if (track.kind === Track.Kind.Video) {
          if (programReturn && isProgramFeed(participant.identity, credentials.programId)) {
            programTracks.set(participant.identity, track);
            showPreferredProgram();
            return;
          }
          show(track);
          return;
        }
        if (track.kind === Track.Kind.Audio && returnAudioRef.current) {
          track.attach(returnAudioRef.current);
          void returnAudioRef.current.play();
        }
        setReturnFeed(true);
      };
      room.on(RoomEvent.TrackPublished, subscribe);
      room.on(RoomEvent.TrackSubscribed, attach);
      room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        if (track.kind === Track.Kind.Video && participant && programTracks.get(participant.identity) === track) {
          programTracks.delete(participant.identity);
          if (shownVideo === track) {
            // Fall back to the other program feed, if any, before letting go of this one.
            const fallback = programTracks.get(preferredProgramFeed(credentials.programId, programTracks.keys())) ?? null;
            show(fallback);
          }
          return;
        }
        if (track === shownVideo) {
          show(null);
          return;
        }
        track.detach();
        setReturnFeed(false);
      });
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Reconnecting) setStatus('reconnecting');
        if (state === ConnectionState.Connected) setStatus('live');
        if (state === ConnectionState.Disconnected && status !== 'left') setStatus('ended');
      });
      // Only a call that got as far as live can drop; a failed join is reported as one.
      let wentLive = false;
      room.on(RoomEvent.Disconnected, (reason) => {
        if (!wentLive || !isDrop(reason)) return;
        pendingDropRef.current = true;
        void heartbeat().catch(() => undefined);
      });
      room.on(RoomEvent.ConnectionQualityChanged, (next, participant) => {
        if (participant.isLocal) setQuality(String(next).toLowerCase());
      });
      room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== 'alcantara-director') return;
        try {
          const command = JSON.parse(new TextDecoder().decode(payload)) as DirectorCommand;
          if (!command.id) return;
          // A media command must name the device it is for; one that does not is ignored like other malformed data.
          if (command.type === 'media' && command.device !== 'camera' && command.device !== 'microphone') return;
          if (command.type === 'media' && command.enabled === false) {
            const operation = command.device === 'camera' ? room.localParticipant.setCameraEnabled(false) : room.localParticipant.setMicrophoneEnabled(false);
            void operation.then(() => {
              if (command.device === 'camera') setCameraEnabled(false);
              else setMicrophoneEnabled(false);
              void acknowledge(command, 'accepted');
            });
          } else if (command.type === 'media' && command.enabled === true) {
            setNotice(command);
          } else if (command.type === 'return') {
            if (command.returnVideo) setReturnVideo(command.returnVideo);
            if (command.returnAudioBus) setReturnAudioBus(command.returnAudioBus);
          } else {
            setNotice(command);
            if (command.type === 'message') void acknowledge(command, 'read');
          }
        } catch {
          // Ignore malformed room data.
        }
      });
      await room.connect(credentials.serverUrl, credentials.token, {
        autoSubscribe: false
      });
      room.remoteParticipants.forEach((participant) => participant.trackPublications.forEach((publication) => subscribe(publication, participant)));
      await room.localParticipant.setCameraEnabled(cameraEnabled, cameraId ? { deviceId: cameraId } : undefined);
      await room.localParticipant.setMicrophoneEnabled(microphoneEnabled, microphoneId ? { deviceId: microphoneId } : undefined);
      const cameraPublication = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (cameraPublication?.videoTrack && previewRef.current) cameraPublication.videoTrack.attach(previewRef.current);
      setStatus('live');
      announceJoinRef.current = true;
      wentLive = true;
      stopHeartbeat();
      heartbeatRef.current = window.setInterval(() => void heartbeat(), 20_000);
      void heartbeat();
    } catch (reason) {
      void reportJoinFailure(invitation, reason);
      // Release the half-joined room, without its listeners reporting the
      // disconnect as an ended session, so a retry starts from a clean room.
      const failedRoom = roomRef.current;
      roomRef.current = null;
      failedRoom?.removeAllListeners();
      failedRoom?.disconnect();
      setError(CONNECT_FAILED);
      setStatus('ready');
    }
  };

  const respondToEnable = async (accepted: boolean) => {
    if (!notice || notice.type !== 'media' || !notice.device) return;
    if (accepted && roomRef.current) {
      if (notice.device === 'camera') {
        await roomRef.current.localParticipant.setCameraEnabled(true);
        setCameraEnabled(true);
      } else {
        await roomRef.current.localParticipant.setMicrophoneEnabled(true);
        setMicrophoneEnabled(true);
      }
    }
    await acknowledge(notice, accepted ? 'accepted' : 'rejected');
    setNotice(null);
  };

  const toggleMedia = async (device: 'camera' | 'microphone') => {
    const next = device === 'camera' ? !cameraEnabled : !microphoneEnabled;
    if (device === 'camera') setCameraEnabled(next);
    else setMicrophoneEnabled(next);
    if (roomRef.current?.state === ConnectionState.Connected) {
      if (device === 'camera') await roomRef.current.localParticipant.setCameraEnabled(next);
      else await roomRef.current.localParticipant.setMicrophoneEnabled(next);
    } else {
      const tracks = device === 'camera' ? localStreamRef.current?.getVideoTracks() : localStreamRef.current?.getAudioTracks();
      tracks?.forEach((track) => {
        track.enabled = next;
      });
    }
  };

  const leave = () => {
    stopHeartbeat();
    roomRef.current?.disconnect();
    setStatus('left');
  };

  const readyToJoin = status === 'ready' && speakerChecked && (headphonesConfirmed || echoRiskAccepted);
  return (
    <main className='min-h-screen bg-zinc-950 px-4 py-8 text-white'>
      <div className='mx-auto max-w-5xl'>
        <header className='mb-7 flex items-center gap-4'>
          <span className='flex h-11 w-11 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300'>
            <Radio size={20} />
          </span>
          <div>
            <p className='text-xs font-semibold uppercase tracking-widest text-amber-300'>Remote contribution</p>
            <h1 className='mt-1 text-2xl font-semibold'>Alcántara guest call</h1>
            <p className='mt-1 text-sm text-white/50'>
              {status === 'live' ? `${displayName} · ${programId} · ${returnVideo} video · ${returnAudioBus} mix-minus` : 'Complete every preflight check, then join explicitly.'}
            </p>
          </div>
          <StatusBadge className='ml-auto' label={status} variant={status === 'live' ? 'live' : status === 'reconnecting' ? 'offline' : 'default'} />
        </header>
        <div className='relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black'>
          {status === 'live' || status === 'reconnecting' ? <video ref={returnVideoRef} autoPlay playsInline className='h-full w-full object-contain' /> : null}
          <audio ref={returnAudioRef} autoPlay playsInline />
          <video
            ref={previewRef}
            autoPlay
            playsInline
            muted
            className={
              status === 'live' || status === 'reconnecting'
                ? 'absolute bottom-4 right-4 aspect-video w-1/4 rounded-lg border-2 border-white/40 bg-black object-cover'
                : 'h-full w-full object-cover'
            }
          />
          {(status === 'live' || status === 'reconnecting') && !returnFeed ? (
            <div className='absolute inset-0 flex items-center justify-center bg-zinc-950/80 text-center'>
              <div>
                <Radio className='mx-auto animate-pulse text-sky-300' />
                <p className='mt-3 font-semibold'>Waiting for selected return feed</p>
                <p className='mt-1 text-xs text-white/50'>
                  {returnVideo} video · {returnAudioBus} N-1 audio
                </p>
              </div>
            </div>
          ) : null}
          {status === 'ended' || status === 'left' ? (
            <div className='absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/95 px-6 text-center text-xl'>
              <p>{status === 'left' ? 'You left the studio.' : 'The studio session ended.'}</p>
              {error ? <p role='alert' className='max-w-md text-base text-amber-200'>{error}</p> : null}
              {/* A rejoin asks the studio again while the invitation is still open; once the join itself was refused,
                  the message above says to ask for a new link and no rejoin is offered. */}
              {invitationClosed ? null : <Button onClick={() => void join()}>Rejoin the studio</Button>}
            </div>
          ) : null}
          {notice ? (
            <div className='absolute inset-x-4 bottom-5 z-20 mx-auto max-w-xl rounded-xl border border-amber-300/50 bg-zinc-950/95 p-5 text-center shadow-2xl'>
              <strong className={notice.type === 'cue' ? 'text-xl uppercase tracking-widest text-amber-300' : ''}>
                {notice.type === 'cue' ? notice.cue : notice.type === 'message' ? notice.text : `Studio requests your ${notice.device}.`}
              </strong>
              <div className='mt-4 flex justify-center gap-2'>
                {notice.type === 'media' ? (
                  <>
                    <Button onClick={() => void respondToEnable(true)}>Accept</Button>
                    <Button variant='secondary' onClick={() => void respondToEnable(false)}>
                      Decline
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => void acknowledge(notice, 'acknowledged')}>
                    <CheckCircle2 size={15} /> Acknowledge
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </div>
        {/* The ended/left panel already shows the message; the banner is for every other state. */}
        {error && status !== 'ended' && status !== 'left' ? (
          <div role='alert' className='mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200'>
            {error}
          </div>
        ) : null}
        <div className='mt-6 flex flex-wrap items-center justify-center gap-3'>
          <Button variant='secondary' onClick={() => void toggleMedia('camera')}>
            {cameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />} {cameraEnabled ? 'Camera on' : 'Camera off'}
          </Button>
          <Button variant='secondary' onClick={() => void toggleMedia('microphone')}>
            {microphoneEnabled ? <Mic size={18} /> : <MicOff size={18} />} {microphoneEnabled ? 'Mic on' : 'Mic off'}
          </Button>
          {status === 'ready' || status === 'error' ? (
            <Button disabled={!readyToJoin} onClick={() => void join()}>
              <Radio size={18} /> Join studio
            </Button>
          ) : null}
          {status === 'joining' ? <Button loading>Joining</Button> : null}
          {status === 'live' || status === 'reconnecting' ? (
            <Button variant='destructive' onClick={leave}>
              <PhoneOff size={18} /> Leave
            </Button>
          ) : null}
        </div>
        {status === 'ready' || status === 'error' ? (
          <div className='mx-auto mt-8 grid max-w-3xl gap-5 rounded-2xl border border-white/10 bg-white/[0.04] p-6 sm:grid-cols-2'>
            <Field label='Camera' className='[&_label]:text-white/70'>
              <Select
                value={cameraId}
                onChange={(value) => void switchDevice('videoinput', value)}
                options={cameras.map((device, index) => ({
                  value: device.deviceId,
                  label: device.label || `Camera ${index + 1}`
                }))}
              />
            </Field>
            <Field label='Microphone' className='[&_label]:text-white/70'>
              <Select
                value={microphoneId}
                onChange={(value) => void switchDevice('audioinput', value)}
                options={microphones.map((device, index) => ({
                  value: device.deviceId,
                  label: device.label || `Microphone ${index + 1}`
                }))}
              />
            </Field>
            <TooltipButton type='button' onClick={() => void playSpeakerTest()} className='flex items-center gap-3 rounded-xl border border-white/10 p-4 text-left hover:bg-white/[0.05]'>
              <Volume2 className={speakerChecked ? 'text-emerald-300' : 'text-sky-300'} />
              <span>
                <strong className='block'>Speaker test</strong>
                <small className='text-white/50'>{speakerChecked ? 'Completed' : 'Play test tone'}</small>
              </span>
            </TooltipButton>
            <div className='rounded-xl border border-white/10 p-4'>
              <strong className='block'>Network</strong>
              <small className='text-white/50'>{network}</small>
            </div>
            <Checkbox
              containerClassName='rounded-xl border border-white/10 p-4'
              checked={headphonesConfirmed}
              onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
              label={<span className='flex items-center gap-3'><Headphones className='text-sky-300' /><strong>I am wearing headphones</strong></span>}
              description='Required to prevent echo.'
            />
            <Checkbox
              containerClassName='rounded-xl border border-amber-300/20 p-4'
              checked={echoRiskAccepted}
              onChange={(event) => setEchoRiskAccepted(event.target.checked)}
              label={<strong className='text-amber-200'>Operator accepted speaker risk</strong>}
              description='Use only when headphones are impossible.'
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
