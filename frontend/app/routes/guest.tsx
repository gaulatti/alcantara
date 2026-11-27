import { TooltipButton } from "../components/BleeckerButtons";
import { Button, Checkbox, Field, Select, StatusBadge } from '@gaulatti/bleecker';
import { Camera, CameraOff, CheckCircle2, Headphones, Mic, MicOff, PhoneOff, Radio, Volume2 } from 'lucide-react';
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { isDrop, reportJoinFailure, roomIcePath } from '../utils/callTelemetry';
import { isProgramFeed, preferredProgramFeed } from '../utils/programFeed';
import { apiUrl } from '../utils/apiBaseUrl';
import { mediaErrorHelp, type MediaHelp } from '../utils/guestMediaHelp';
import { GUEST_RETURN_COPY, RETURN_STALL_MS, guestReturnState, returnFeedHealthFor } from '../components/guest/guestReturnCopy';
import { GuestReturnLevel } from '../components/guest/GuestReturnLevel';
import type { Route } from './+types/guest';

type GuestStatus = 'preflight' | 'ready' | 'joining' | 'waiting' | 'live' | 'reconnecting' | 'left' | 'ended' | 'error';
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
const CONNECT_FAILED = 'Could not connect to the studio. Check your Wi-Fi or mobile data, then try again.';
const DROPPED = 'Your connection to the studio dropped. Check your Wi-Fi or mobile data, then rejoin.';
// The studio removed this guest from the room: not a network drop, and the same link can join again.
const REMOVED = 'The studio removed you from the call. You can rejoin with the same link.';

export default function GuestRoute() {
  const { invitation = '' } = useParams();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const returnVideoRef = useRef<HTMLVideoElement | null>(null);
  const returnAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const sessionTokenRef = useRef('');
  const heartbeatRef = useRef<number | null>(null);
  // Set while the guest waits to be admitted: the heartbeat then watches for the answer.
  const waitingRef = useRef(false);
  // The heartbeat rejoins on admission through this, so it uses the camera and microphone choices as they are then.
  const joinRef = useRef<() => Promise<void>>(async () => {});
  // Set at each join until a heartbeat has told the studio, so one join is counted once.
  const announceJoinRef = useRef(false);
  // A lost call is reported by the next heartbeat that gets through.
  const pendingDropRef = useRef(false);
  const [status, setStatus] = useState<GuestStatus>('preflight');
  const [error, setError] = useState('');
  // The plain-words help for a refused camera or microphone, and the attempt number that re-runs the preflight.
  const [mediaHelp, setMediaHelp] = useState<MediaHelp | null>(null);
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  // Set when the page itself ends the call (leave, or a revoked session), so the disconnect is not reported as a drop.
  const intentionalEndRef = useRef(false);
  // Set when the studio removes this guest, so the disconnect that follows is reported as a removal, not a drop.
  const removedRef = useRef(false);
  // The join was refused (401/403): the invitation is closed, so a rejoin cannot succeed (gaulatti/alcantara#353).
  const [invitationClosed, setInvitationClosed] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [speakerChecked, setSpeakerChecked] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');
  const [network, setNetwork] = useState('Checking network…');
  const [quality, setQuality] = useState('unknown');
  const [returnFeed, setReturnFeed] = useState(false);
  // Whether the guest has heard the studio's return on this call: it tells "connecting" from "dropped".
  const [returnEverPlayed, setReturnEverPlayed] = useState(false);
  // True once the return has been missing for RETURN_STALL_MS on air: the guest is then told it is not reaching them.
  const [returnStalled, setReturnStalled] = useState(false);
  // The return participant whose audio is playing, read for the level meter.
  const returnLevelSource = useRef<RemoteParticipant | null>(null);
  const [displayName, setDisplayName] = useState('Guest');
  const [programId, setProgramId] = useState('');
  const [returnVideo, setReturnVideo] = useState('program');
  const [returnAudioBus, setReturnAudioBus] = useState('master');
  const [notice, setNotice] = useState<DirectorCommand | null>(null);
  // The heartbeat is scheduled once per join, so it reads the call through this ref, kept current on every
  // render: each heartbeat reports the call as it is, not as it was at join (gaulatti/alcantara#672).
  const telemetryRef = useRef({ quality, returnFeed, returnStalled: false, cameraEnabled, microphoneEnabled });
  telemetryRef.current = { quality, returnFeed, returnStalled, cameraEnabled, microphoneEnabled };

  // Tells the studio the guest ended the call, so a stopped heartbeat is not counted as a drop. `keepalive` lets
  // it go out while the page is closing.
  const sayLeft = () => {
    if (!sessionTokenRef.current) return;
    void fetch(apiUrl('/webrtc/session/heartbeat'), {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: sessionTokenRef.current, telemetry: { left: true } })
    }).catch(() => undefined);
  };

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
          returnFeedHealth: returnFeedHealthFor({ returnFeed: telemetry.returnFeed, stalled: telemetry.returnStalled }),
          cameraEnabled: telemetry.cameraEnabled,
          microphoneEnabled: telemetry.microphoneEnabled,
          ...(icePath ? { iceTransport: icePath } : {}),
          ...(joined ? { joined: true } : {}),
          ...(dropped ? { dropped: true } : {})
        }
      })
    });
    if (response.ok && dropped) pendingDropRef.current = false;
    if (response.ok && waitingRef.current) {
      const answer = (await response.json().catch(() => null)) as { admission?: string } | null;
      // Another heartbeat may have seen it first.
      if (answer?.admission === 'admitted' && waitingRef.current) {
        waitingRef.current = false;
        stopHeartbeat();
        intentionalEndRef.current = true;
        roomRef.current?.disconnect();
        roomRef.current = null;
        void joinRef.current();
      }
      return;
    }
    if (response.status === 401 || response.status === 403) {
      const declined = waitingRef.current;
      waitingRef.current = false;
      stopHeartbeat();
      intentionalEndRef.current = true;
      roomRef.current?.disconnect();
      setStatus('ended');
      setError(declined ? 'The studio did not let you in. Ask them for a new link if this was a mistake.' : 'The studio ended or revoked this guest session.');
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
        setMediaHelp(mediaErrorHelp(reason, navigator.userAgent));
        setStatus('error');
      }
    };
    void prepare();
    window.addEventListener('pagehide', sayLeft);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', sayLeft);
      if (heartbeatRef.current !== null) sayLeft();
      stopHeartbeat();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      roomRef.current?.disconnect();
    };
  }, [preflightAttempt]);

  const retryPreflight = () => {
    setMediaHelp(null);
    setError('');
    setStatus('preflight');
    setPreflightAttempt((attempt) => attempt + 1);
  };

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
    // The rejoin after a drop starts from a state that is not 'ready', so the guard is the checks, not the status.
    if (!speakerChecked || !headphonesConfirmed) return;
    setStatus('joining');
    setError('');
    intentionalEndRef.current = false;
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
        // Absent from a backend without screening: the guest goes straight in.
        admission?: 'waiting' | 'admitted';
      };
      window.sessionStorage.setItem(storageKey, credentials.sessionToken);
      sessionTokenRef.current = credentials.sessionToken;
      setDisplayName(credentials.displayName);
      setProgramId(credentials.programId);
      setReturnVideo(credentials.returnVideo);
      setReturnAudioBus(credentials.returnAudioBus);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;

      if (credentials.admission === 'waiting') {
        await waitForAdmission(credentials.serverUrl, credentials.token);
        return;
      }
      waitingRef.current = false;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true
      });
      roomRef.current = room;
      // A new room has no return feed and no quality reading yet: a rejoin does not report the last room's.
      setReturnFeed(false);
      setReturnEverPlayed(false);
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
          returnLevelSource.current = participant;
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
        if (track.kind === Track.Kind.Audio) returnLevelSource.current = null;
        setReturnFeed(false);
      });
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Reconnecting) setStatus('reconnecting');
        if (state === ConnectionState.Connected) setStatus('live');
        if (state === ConnectionState.Disconnected && !intentionalEndRef.current) {
          if (!removedRef.current) setError(DROPPED);
          setStatus('ended');
        }
      });
      // Only a call that got as far as live can drop; a failed join is reported as one.
      let wentLive = false;
      room.on(RoomEvent.Disconnected, (reason) => {
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          removedRef.current = true;
          setError(REMOVED);
          setStatus('ended');
          return;
        }
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

  // Before admission: a room of the guest's own, where only the producer can see, hear and talk to them.
  const waitForAdmission = async (serverUrl: string, token: string) => {
    const room = new Room({ disconnectOnPageLeave: true });
    roomRef.current = room;
    intentionalEndRef.current = false;
    removedRef.current = false;
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio || !returnAudioRef.current) return;
      track.attach(returnAudioRef.current);
      void returnAudioRef.current.play();
    });
    // Admitting or declining ends this connection: ask at once which it was.
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room || intentionalEndRef.current) return;
      void heartbeat()
        .catch(() => undefined)
        .finally(() => {
          // Neither: the connection itself is gone. Nobody can see or hear the guest, so offer to rejoin.
          if (!waitingRef.current || roomRef.current !== room) return;
          waitingRef.current = false;
          stopHeartbeat();
          intentionalEndRef.current = true;
          setError(DROPPED);
          setStatus('ended');
        });
    });
    await room.connect(serverUrl, token);
    await room.localParticipant.setCameraEnabled(cameraEnabled, cameraId ? { deviceId: cameraId } : undefined);
    await room.localParticipant.setMicrophoneEnabled(microphoneEnabled, microphoneId ? { deviceId: microphoneId } : undefined);
    const camera = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (camera?.videoTrack && previewRef.current) camera.videoTrack.attach(previewRef.current);
    waitingRef.current = true;
    setStatus('waiting');
    stopHeartbeat();
    heartbeatRef.current = window.setInterval(() => void heartbeat().catch(() => undefined), 3_000);
    void heartbeat().catch(() => undefined);
  };

  joinRef.current = join;

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
    waitingRef.current = false;
    sayLeft();
    stopHeartbeat();
    intentionalEndRef.current = true;
    roomRef.current?.disconnect();
    setStatus('left');
  };

  useEffect(() => {
    if (returnFeed) setReturnEverPlayed(true);
  }, [returnFeed]);

  // Starts when the guest is on air (admission) and again on every drop; cleared the moment the return is back.
  useEffect(() => {
    if ((status !== 'live' && status !== 'reconnecting') || returnFeed) {
      setReturnStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setReturnStalled(true), RETURN_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [status, returnFeed]);

  // The join needs the speaker test and the headphones confirmation. The page says which one is still missing.
  const readyToJoin = status === 'ready' && speakerChecked && headphonesConfirmed;
  const joinBlockedBy = !speakerChecked ? 'Play the test tone first.' : !headphonesConfirmed ? 'Confirm you are wearing headphones.' : '';
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
              {status === 'live' ? `${displayName} · ${programId} · ${returnVideo} video · ${returnAudioBus} mix-minus` : status === 'waiting' ? `${displayName} · ${programId} · not on air` : 'Complete every preflight check, then join explicitly.'}
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
                ? 'absolute bottom-4 right-4 z-10 aspect-video w-1/4 rounded-lg border-2 border-white/40 bg-black object-cover'
                : 'h-full w-full object-cover'
            }
          />
          {(status === 'live' || status === 'reconnecting') && !returnFeed ? (
            <div className='absolute inset-0 flex items-center justify-center bg-zinc-950/80 px-6 text-center'>
              <div>
                <Radio className='mx-auto animate-pulse text-sky-300' />
                <p role='status' className='mt-3 max-w-sm font-semibold'>
                  {GUEST_RETURN_COPY[guestReturnState({ returnFeed, everPlayed: returnEverPlayed, stalled: returnStalled })]}
                </p>
              </div>
            </div>
          ) : null}
          {(status === 'live' || status === 'reconnecting') && returnFeed ? (
            <div className='absolute bottom-4 left-4 z-10 flex items-center gap-3 rounded-lg bg-zinc-950/70 px-3 py-2 text-sm'>
              <span role='status'>{GUEST_RETURN_COPY.playing}</span>
              <GuestReturnLevel read={() => returnLevelSource.current?.audioLevel ?? 0} />
            </div>
          ) : null}
          {status === 'waiting' ? (
            <div role='status' className='absolute inset-x-0 bottom-0 bg-zinc-950/85 px-4 py-3 text-center'>
              <p className='font-semibold'>Waiting for the producer to let you in</p>
              <p className='mt-1 text-xs text-white/60'>You are not on air. The producer can see and hear you, and you will hear them here.</p>
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
        {mediaHelp && status === 'error' ? (
          <div role='alert' className='mt-4 rounded-xl border border-amber-300/40 bg-amber-300/10 p-4 text-sm text-amber-100'>
            <p className='font-semibold'>{mediaHelp.title}</p>
            <ol className='mt-2 list-decimal space-y-1 pl-5 text-white/80'>
              {mediaHelp.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Button className='mt-4 w-full' onClick={retryPreflight}>
              Try again
            </Button>
          </div>
        ) : null}
        {/* The ended/left panel already shows the message; the banner is for every other state. */}
        {error && status !== 'ended' && status !== 'left' ? (
          <div role='alert' className='mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200'>
            {error}
          </div>
        ) : null}
        {/* Phones get two equal columns the thumb can reach; the join and leave controls take a full row. */}
        <div className='mt-6 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-center'>
          <Button variant='secondary' onClick={() => void toggleMedia('camera')}>
            {cameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />} {cameraEnabled ? 'Camera on' : 'Camera off'}
          </Button>
          <Button variant='secondary' onClick={() => void toggleMedia('microphone')}>
            {microphoneEnabled ? <Mic size={18} /> : <MicOff size={18} />} {microphoneEnabled ? 'Mic on' : 'Mic off'}
          </Button>
          {status === 'ready' || status === 'error' ? (
            <div className='col-span-2 flex flex-col items-stretch gap-2 sm:col-span-1 sm:items-center'>
              <Button
                className='w-full'
                disabled={!readyToJoin}
                aria-describedby={!readyToJoin && joinBlockedBy ? 'join-blocked-reason' : undefined}
                onClick={() => void join()}
              >
                <Radio size={18} /> Join studio
              </Button>
              {!readyToJoin && joinBlockedBy ? (
                <p id='join-blocked-reason' className='text-center text-sm text-amber-200'>
                  {joinBlockedBy}
                </p>
              ) : null}
            </div>
          ) : null}
          {status === 'joining' ? <Button loading>Joining</Button> : null}
          {status === 'waiting' || status === 'live' || status === 'reconnecting' ? (
            <Button className='col-span-2 sm:col-span-1' variant='destructive' onClick={leave}>
              <PhoneOff size={18} /> Leave
            </Button>
          ) : null}
        </div>
        {status === 'ready' || status === 'error' ? (
          <>
          <ol aria-label='Steps to join' className='mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-2 text-sm text-white/70'>
            <li className={speakerChecked ? 'text-emerald-300' : 'font-semibold text-sky-200'}>
              1. {speakerChecked ? 'Speaker tested' : 'Play the test tone'}
            </li>
            <li aria-hidden='true' className='text-white/30'>›</li>
            <li className={headphonesConfirmed ? 'text-emerald-300' : speakerChecked ? 'font-semibold text-sky-200' : ''}>
              2. {headphonesConfirmed ? 'Headphones confirmed' : 'Confirm headphones'}
            </li>
            <li aria-hidden='true' className='text-white/30'>›</li>
            <li className={readyToJoin ? 'font-semibold text-sky-200' : ''}>3. Join studio</li>
          </ol>
          <div className='mx-auto mt-4 grid max-w-3xl gap-5 rounded-2xl border border-white/10 bg-white/[0.04] p-6 sm:grid-cols-2'>
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
            <TooltipButton
              type='button'
              onClick={() => void playSpeakerTest()}
              aria-current={!speakerChecked ? 'step' : undefined}
              className={`flex items-center gap-3 rounded-xl border p-4 text-left hover:bg-white/[0.05] ${
                !speakerChecked ? 'border-sky-300 bg-sky-300/10 ring-2 ring-sky-300' : 'border-white/10'
              }`}
            >
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
              containerClassName={`rounded-xl border p-4 ${
                speakerChecked && !headphonesConfirmed ? 'border-sky-300 bg-sky-300/10 ring-2 ring-sky-300' : 'border-white/10'
              }`}
              checked={headphonesConfirmed}
              onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
              label={<span className='flex items-center gap-3'><Headphones className='text-sky-300' /><strong>I am wearing headphones</strong></span>}
              description='Required to prevent echo.'
            />
          </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
