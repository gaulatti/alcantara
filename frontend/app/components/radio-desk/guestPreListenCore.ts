import { holdLocalAudio } from "../../utils/localAudio";
import { RoomEvent, Track } from "livekit-client";

// Guest pre-fade listen (gaulatti/alcantara#835). The operator's browser subscribes to one guest's microphone track and
// plays it to this device's cue output. It publishes nothing: no track, no microphone or camera, no mix-minus, no return,
// no air. Talkback is a separate path and stays so. One guest at a time; stopping unsubscribes and detaches.

/** The parts of a LiveKit track this module uses, so the rules can be tested without a live room. */
export interface PreListenTrack {
  attach(): HTMLMediaElement;
  detach(element?: HTMLMediaElement): unknown;
}

export interface PreListenPublication {
  kind?: string;
  source?: string;
  track?: PreListenTrack | null;
  setSubscribed(value: boolean): unknown;
}

export interface PreListenParticipant {
  identity: string;
  trackPublications: Map<string, PreListenPublication>;
}

export interface PreListenRoom {
  remoteParticipants: Map<string, PreListenParticipant>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export type GuestPreListenState =
  | { status: "idle" }
  | { status: "listening"; identity: string; subscribed: boolean }
  | { status: "error"; identity: string; message: string };

/** The guest's own microphone: the one track of theirs that is their voice. */
export function guestMicrophone(participant: PreListenParticipant): PreListenPublication | null {
  for (const publication of participant.trackPublications.values()) {
    if (publication.kind === "audio" && publication.source === Track.Source.Microphone) return publication;
  }
  return null;
}

export function createGuestPreListen(room: PreListenRoom, onChange: (state: GuestPreListenState) => void) {
  let current: {
    identity: string;
    publication: PreListenPublication;
    element: HTMLMediaElement | null;
    subscribed: boolean;
  } | null = null;

  const set = (state: GuestPreListenState) => onChange(state);
  let release: (() => void) | null = null;

  const attach = () => {
    if (!current || current.element || !current.publication.track) return;
    current.element = current.publication.track.attach();
    // Muted while the host microphone is open without headphones: the guest would hear themselves on air.
    release = holdLocalAudio(current.element);
    set({ status: "listening", identity: current.identity, subscribed: true });
  };

  const onSubscribed = (_track: unknown, publication: PreListenPublication, participant: PreListenParticipant) => {
    if (!current || participant.identity !== current.identity || publication !== current.publication) return;
    attach();
  };

  const stop = () => {
    if (!current) return;
    const { element, publication } = current;
    release?.();
    release = null;
    if (element) publication.track?.detach(element);
    if (current.subscribed) publication.setSubscribed(false);
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    current = null;
    set({ status: "idle" });
  };

  const start = (identity: string) => {
    stop();
    const participant = room.remoteParticipants.get(identity);
    if (!participant) {
      set({ status: "error", identity, message: "This guest is not in the room." });
      return;
    }
    const publication = guestMicrophone(participant);
    if (!publication) {
      set({ status: "error", identity, message: "This guest has no microphone to listen to." });
      return;
    }
    current = { identity, publication, element: null, subscribed: true };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    // Subscribing is the whole of it: no publish, no mute, no permission change.
    publication.setSubscribed(true);
    set({ status: "listening", identity, subscribed: false });
    attach();
  };

  return {
    start,
    stop,
    get identity() {
      return current?.identity ?? null;
    },
  };
}
