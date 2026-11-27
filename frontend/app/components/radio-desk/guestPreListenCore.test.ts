// Guest pre-fade listen (gaulatti/alcantara#835): selecting a guest subscribes to the guest's microphone and plays it
// to this device only. Nothing is published, and nothing can be: the room here has no publishing surface at all.
import { RoomEvent } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { createGuestPreListen, guestMicrophone, type PreListenParticipant, type PreListenPublication, type PreListenRoom } from "./guestPreListenCore";

function track() {
  const element = { muted: true } as unknown as HTMLMediaElement;
  return { element, attach: vi.fn(() => element), detach: vi.fn() };
}

function publication(kind: string, source: string, attached: ReturnType<typeof track> | null) {
  return {
    kind,
    source,
    track: attached,
    setSubscribed: vi.fn(),
  } as unknown as PreListenPublication & { setSubscribed: ReturnType<typeof vi.fn> };
}

function guest(identity: string, publications: PreListenPublication[]): PreListenParticipant {
  return {
    identity,
    trackPublications: new Map(publications.map((pub, index) => [`${identity}-${index}`, pub])),
  };
}

function room(participants: PreListenParticipant[]) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const remote = new Map(participants.map((participant) => [participant.identity, participant]));
  const fake = {
    remoteParticipants: remote,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return fake as typeof fake & PreListenRoom;
}

describe("guestMicrophone", () => {
  it("picks the guest's microphone, never a camera", () => {
    const camera = publication("video", "camera", null);
    const mic = publication("audio", "microphone", null);
    expect(guestMicrophone(guest("guest-1", [camera, mic]))).toBe(mic);
    expect(guestMicrophone(guest("guest-2", [camera]))).toBeNull();
  });
});

describe("createGuestPreListen", () => {
  it("subscribes to the guest's microphone and plays it to this device, publishing nothing", () => {
    const sound = track();
    const mic = publication("audio", "microphone", sound);
    const fake = room([guest("guest-a", [mic])]);
    const states: unknown[] = [];
    const pfl = createGuestPreListen(fake, (state) => states.push(state));

    pfl.start("guest-a");

    expect(mic.setSubscribed).toHaveBeenCalledWith(true);
    expect(sound.attach).toHaveBeenCalledTimes(1);
    expect(sound.element.muted).toBe(false);
    expect(pfl.identity).toBe("guest-a");
    expect(states.at(-1)).toEqual({ status: "listening", identity: "guest-a", subscribed: true });
    // The room is a read-and-subscribe surface: it has no way to publish, and nothing here asks for it.
    expect(Object.keys(fake)).not.toEqual(expect.arrayContaining(["publishTrack", "setMicrophoneEnabled", "setCameraEnabled"]));
    expect(fake.on).toHaveBeenCalledWith(RoomEvent.TrackSubscribed, expect.any(Function));
  });

  it("attaches once the microphone's subscription arrives, when it is not there yet", () => {
    const sound = track();
    const mic = publication("audio", "microphone", null);
    const fake = room([guest("guest-a", [mic])]);
    const pfl = createGuestPreListen(fake, () => undefined);

    pfl.start("guest-a");
    expect(sound.attach).not.toHaveBeenCalled();

    (mic as { track: unknown }).track = sound;
    fake.emit(RoomEvent.TrackSubscribed, sound, mic, fake.remoteParticipants.get("guest-a"));
    expect(sound.attach).toHaveBeenCalledTimes(1);
  });

  it("ignores a subscription for another guest's track", () => {
    const sound = track();
    const mic = publication("audio", "microphone", null);
    const other = publication("audio", "microphone", null);
    const fake = room([guest("guest-a", [mic]), guest("guest-b", [other])]);
    createGuestPreListen(fake, () => undefined).start("guest-a");

    (other as { track: unknown }).track = sound;
    fake.emit(RoomEvent.TrackSubscribed, sound, other, fake.remoteParticipants.get("guest-b"));
    expect(sound.attach).not.toHaveBeenCalled();
  });

  it("stops by detaching the sound and unsubscribing, and never publishes", () => {
    const sound = track();
    const mic = publication("audio", "microphone", sound);
    const fake = room([guest("guest-a", [mic])]);
    const pfl = createGuestPreListen(fake, () => undefined);
    pfl.start("guest-a");

    pfl.stop();

    expect(sound.detach).toHaveBeenCalledWith(sound.element);
    expect(mic.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(fake.off).toHaveBeenCalledWith(RoomEvent.TrackSubscribed, expect.any(Function));
    expect(pfl.identity).toBeNull();
  });

  it("keeps one guest at a time: selecting another stops the first", () => {
    const soundA = track();
    const soundB = track();
    const micA = publication("audio", "microphone", soundA);
    const micB = publication("audio", "microphone", soundB);
    const fake = room([guest("guest-a", [micA]), guest("guest-b", [micB])]);
    const pfl = createGuestPreListen(fake, () => undefined);

    pfl.start("guest-a");
    pfl.start("guest-b");

    expect(micA.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(soundA.detach).toHaveBeenCalled();
    expect(micB.setSubscribed).toHaveBeenCalledWith(true);
    expect(pfl.identity).toBe("guest-b");
  });

  it("reports a guest who is not in the room, without subscribing to anything", () => {
    const fake = room([]);
    const states: unknown[] = [];
    createGuestPreListen(fake, (state) => states.push(state)).start("guest-x");
    expect(states.at(-1)).toEqual({ status: "error", identity: "guest-x", message: "This guest is not in the room." });
  });

  it("reports a guest with no microphone, without subscribing", () => {
    const camera = publication("video", "camera", null);
    const fake = room([guest("guest-a", [camera])]);
    const states: unknown[] = [];
    createGuestPreListen(fake, (state) => states.push(state)).start("guest-a");
    expect(states.at(-1)).toEqual({ status: "error", identity: "guest-a", message: "This guest has no microphone to listen to." });
    expect(camera.setSubscribed).not.toHaveBeenCalled();
  });
});
