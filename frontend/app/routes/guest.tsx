import { Button, Field, Select, StatusBadge } from '@gaulatti/bleecker';
import { Camera, CameraOff, CheckCircle2, Headphones, Mic, MicOff, PhoneOff, Radio, Volume2 } from 'lucide-react';
import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
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

export default function GuestRoute() {
  const { invitation = '' } = useParams();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const returnVideoRef = useRef<HTMLVideoElement | null>(null);
  const returnAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const sessionTokenRef = useRef('');
  const heartbeatRef = useRef<number | null>(null);
  const [status, setStatus] = useState<GuestStatus>('preflight');
  const [error, setError] = useState('');
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

  const stopHeartbeat = () => {
    if (heartbeatRef.current !== null) window.clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
  };

  const heartbeat = async () => {
    if (!sessionTokenRef.current) return;
    const response = await fetch(apiUrl('/webrtc/session/heartbeat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: sessionTokenRef.current,
        telemetry: {
          connectionState: roomRef.current?.state ?? 'disconnected',
          quality,
          returnFeedHealth: returnFeed ? 'healthy' : 'missing',
          cameraEnabled,
          microphoneEnabled
        }
      })
    });
    if (response.status === 401 || response.status === 403) {
      stopHeartbeat();
      roomRef.current?.disconnect();
      setStatus('ended');
      setError('The studio ended or revoked this guest session.');
    }
  };

  const acknowledge = async (command: DirectorCommand, commandStatus: 'accepted' | 'rejected' | 'read' | 'acknowledged') => {
    if (!sessionTokenRef.current) return;
    await fetch(apiUrl(`/webrtc/commands/${encodeURIComponent(command.id)}/ack`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: sessionTokenRef.current,
        status: commandStatus
      })
    });
    if (commandStatus !== 'rejected') setNotice(null);
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
    try {
      const storageKey = `alcantara-guest-session:${invitation.split('.')[0] || 'unknown'}`;
      const previousSession = window.sessionStorage.getItem(storageKey);
      const response = await fetch(apiUrl('/webrtc/join'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitation, sessionToken: previousSession })
      });
      if (!response.ok) throw new Error(await responseError(response));
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
      const wantedParticipant = (participant: RemoteParticipant) =>
        participant.identity === `program-feed-${credentials.programId}` ||
        participant.identity === `preview-feed-${credentials.programId}` ||
        participant.identity.startsWith('return-router-');
      const wantedTrack = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!wantedParticipant(participant)) return false;
        if (publication.kind === Track.Kind.Video) {
          return credentials.returnVideo !== 'none' && participant.identity === `${credentials.returnVideo}-feed-${credentials.programId}`;
        }
        return publication.trackName === `mixminus:${credentials.participantIdentity}:${credentials.returnAudioBus}`;
      };
      const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        void publication.setSubscribed(wantedTrack(publication, participant));
      };
      const attach = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!wantedTrack(publication, participant)) return;
        if (track.kind === Track.Kind.Video && returnVideoRef.current) track.attach(returnVideoRef.current);
        if (track.kind === Track.Kind.Audio && returnAudioRef.current) {
          track.attach(returnAudioRef.current);
          void returnAudioRef.current.play();
        }
        setReturnFeed(true);
      };
      room.on(RoomEvent.TrackPublished, subscribe);
      room.on(RoomEvent.TrackSubscribed, attach);
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        setReturnFeed(false);
      });
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Reconnecting) setStatus('reconnecting');
        if (state === ConnectionState.Connected) setStatus('live');
        if (state === ConnectionState.Disconnected && status !== 'left') setStatus('ended');
      });
      room.on(RoomEvent.ConnectionQualityChanged, (next, participant) => {
        if (participant.isLocal) setQuality(String(next).toLowerCase());
      });
      room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== 'alcantara-director') return;
        try {
          const command = JSON.parse(new TextDecoder().decode(payload)) as DirectorCommand;
          if (!command.id) return;
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
      stopHeartbeat();
      heartbeatRef.current = window.setInterval(() => void heartbeat(), 20_000);
      void heartbeat();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to join the studio.');
      setStatus('error');
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
            <div className='absolute inset-0 flex items-center justify-center bg-zinc-950/95 text-xl'>
              {status === 'left' ? 'You left the studio.' : 'The studio session ended.'}
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
        {error ? (
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
            <button type='button' onClick={() => void playSpeakerTest()} className='flex items-center gap-3 rounded-xl border border-white/10 p-4 text-left hover:bg-white/[0.05]'>
              <Volume2 className={speakerChecked ? 'text-emerald-300' : 'text-sky-300'} />
              <span>
                <strong className='block'>Speaker test</strong>
                <small className='text-white/50'>{speakerChecked ? 'Completed' : 'Play test tone'}</small>
              </span>
            </button>
            <div className='rounded-xl border border-white/10 p-4'>
              <strong className='block'>Network</strong>
              <small className='text-white/50'>{network}</small>
            </div>
            <label className='flex items-center gap-3 rounded-xl border border-white/10 p-4'>
              <input type='checkbox' checked={headphonesConfirmed} onChange={(event) => setHeadphonesConfirmed(event.target.checked)} />
              <Headphones className='text-sky-300' />
              <span>
                <strong className='block'>I am wearing headphones</strong>
                <small className='text-white/50'>Required to prevent echo.</small>
              </span>
            </label>
            <label className='flex items-center gap-3 rounded-xl border border-amber-300/20 p-4'>
              <input type='checkbox' checked={echoRiskAccepted} onChange={(event) => setEchoRiskAccepted(event.target.checked)} />
              <span>
                <strong className='block text-amber-200'>Operator accepted speaker risk</strong>
                <small className='text-white/50'>Use only when headphones are impossible.</small>
              </span>
            </label>
          </div>
        ) : null}
      </div>
    </main>
  );
}
