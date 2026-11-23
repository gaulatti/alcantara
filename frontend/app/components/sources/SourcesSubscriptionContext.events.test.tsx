import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lk = vi.hoisted(() => ({
  created: [] as any[],
  RoomEvent: {
    TrackPublished: "pub",
    TrackSubscribed: "sub",
    TrackUnsubscribed: "unsub",
    TrackSubscriptionFailed: "fail",
    ParticipantDisconnected: "gone",
    ActiveSpeakersChanged: "speakers",
  },
}));
vi.mock("livekit-client", () => {
  class Room {
    handlers = new Map<string, (...a: any[]) => void>();
    remoteParticipants = new Map<string, any>();
    on = vi.fn((e: string, h: any) => void this.handlers.set(e, h));
    off = vi.fn();
    constructor() {
      lk.created.push(this);
    }
  }
  return { Room, RoomEvent: lk.RoomEvent };
});

import { SourcesSubscriptionProvider, useSourcesSubscriptionContext, useSourceSubscription } from "./SourcesSubscriptionContext";

const fakeRoom = (extra: any = {}) => {
  const room: any = {
    handlers: new Map<string, (...a: any[]) => void>(),
    remoteParticipants: new Map<string, any>(),
    on: vi.fn((e: string, h: any) => void room.handlers.set(e, h)),
    off: vi.fn(),
    ...extra,
  };
  return room;
};
const pub = (track: any = null) => ({ track, setSubscribed: vi.fn() });
const wrapperFor = (room?: any) => ({ children }: { children: ReactNode }) => <SourcesSubscriptionProvider room={room}>{children}</SourcesSubscriptionProvider>;
const ctx = (room?: any) => renderHook(() => useSourcesSubscriptionContext(), { wrapper: wrapperFor(room) });
const emit = (room: any, event: string, ...args: any[]) => act(() => room.handlers.get(event)!(...args));

beforeEach(() => {
  lk.created.length = 0;
});
afterEach(cleanup);

describe("SourcesSubscriptionProvider", () => {
  it("creates its own room when none is given", () => {
    const { result } = ctx();
    expect(result.current.room).toBe(lk.created[0]);
    expect(lk.created[0].on).toHaveBeenCalledTimes(6);
  });
  it("must be used inside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSourcesSubscriptionContext())).toThrow("must be used within a SourcesSubscriptionProvider");
    spy.mockRestore();
  });
  it("reads the default state of an unknown source", () => {
    const { result } = ctx(fakeRoom());
    expect(result.current.getSourceState("x")).toEqual({ participantIdentity: "x", videoTrack: null, audioTrack: null, audioLevel: 0, error: null, isSubscribed: false });
    expect(result.current.getSourceState("x")).toBe(result.current.getSourceState("x"));
  });
  it("subscribes to a source's existing tracks once, however many viewers", () => {
    const room = fakeRoom();
    const video = { kind: "video" };
    const audio = { kind: "audio" };
    const vp = pub(video);
    const ap = pub(audio);
    room.remoteParticipants.set("cam", { trackPublications: new Map<string, unknown>([["1", vp], ["2", ap], ["3", pub({ kind: "data" })], ["4", pub()], ["5", null], ["6", {}]]) });
    const { result } = ctx(room);
    let off1!: () => void;
    let off2!: () => void;
    act(() => void (off1 = result.current.subscribeSource("cam")));
    act(() => void (off2 = result.current.subscribeSource("cam")));
    expect(vp.setSubscribed).toHaveBeenCalledTimes(1);
    expect(result.current.getSourceState("cam")).toMatchObject({ isSubscribed: true, videoTrack: video, audioTrack: audio });
    act(() => off1());
    expect(vp.setSubscribed).not.toHaveBeenCalledWith(false);
    act(() => off2());
    expect(vp.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(result.current.getSourceState("cam").isSubscribed).toBe(false);
  });
  it("finds participants in older room shapes and plain-object publications", () => {
    const viaParticipants = fakeRoom({ remoteParticipants: undefined, participants: new Map([["a", { trackPublications: { x: pub({ kind: "video" }) } }]]) });
    const a = ctx(viaParticipants);
    act(() => void a.result.current.subscribeSource("a"));
    expect(a.result.current.getSourceState("a").videoTrack).toEqual({ kind: "video" });
    cleanup();
    const viaArray = fakeRoom({ remoteParticipants: [{ identity: "b", trackPublications: new Map([["1", pub({ kind: "audio" })]]) }] });
    const b = ctx(viaArray);
    let off!: () => void;
    act(() => void (off = b.result.current.subscribeSource("b")));
    expect(b.result.current.getSourceState("b").audioTrack).toEqual({ kind: "audio" });
    act(() => off());
    cleanup();
    const neither = fakeRoom({ remoteParticipants: undefined });
    const c = ctx(neither);
    act(() => void c.result.current.subscribeSource("c"));
    expect(c.result.current.getSourceState("c").isSubscribed).toBe(true);
    cleanup();
    const noPublications = fakeRoom();
    noPublications.remoteParticipants.set("d", {});
    const d = ctx(noPublications);
    let offD!: () => void;
    act(() => void (offD = d.result.current.subscribeSource("d")));
    act(() => offD());
  });
  it("tolerates a missing room and releasing twice", () => {
    const { result } = ctx(fakeRoom({ on: undefined }));
    let off!: () => void;
    act(() => void (off = result.current.subscribeSource("z")));
    act(() => off());
    act(() => off());
    expect(result.current.getSourceState("z").isSubscribed).toBe(false);
  });
  it("tolerates a room that cannot unsubscribe and listeners that cannot be removed", () => {
    const room = fakeRoom({ off: undefined });
    const view = ctx(room);
    view.unmount();
    expect(room.on).toHaveBeenCalled();
  });
  it("removes its listeners when it unmounts", () => {
    const room = fakeRoom();
    ctx(room).unmount();
    expect(room.off).toHaveBeenCalledTimes(6);
  });

  describe("room events", () => {
    const setup = () => {
      const room = fakeRoom();
      const { result } = ctx(room);
      act(() => void result.current.subscribeSource("cam"));
      return { room, result };
    };
    it("subscribes to newly published tracks of watched sources only", () => {
      const { room } = setup();
      const watched = pub();
      const other = pub();
      emit(room, "pub", watched, { identity: "cam" });
      emit(room, "pub", other, { identity: "nobody" });
      emit(room, "pub", {}, { identity: "cam" });
      emit(room, "pub", watched, {});
      emit(room, "pub", watched, undefined);
      expect(watched.setSubscribed).toHaveBeenCalledWith(true);
      expect(other.setSubscribed).not.toHaveBeenCalled();
    });
    it("stores subscribed video and audio tracks of watched sources and ignores the rest", () => {
      const { room, result } = setup();
      emit(room, "sub", { kind: "video" }, {}, { identity: "cam" });
      emit(room, "sub", { kind: "audio" }, {}, { identity: "cam" });
      emit(room, "sub", { kind: "data" }, {}, { identity: "cam" });
      emit(room, "sub", { kind: "video" }, {}, { identity: "nobody" });
      emit(room, "sub", { kind: "video" }, {}, {});
      expect(result.current.getSourceState("cam")).toMatchObject({ videoTrack: { kind: "video" }, audioTrack: { kind: "audio" } });
      expect(result.current.getSourceState("nobody").videoTrack).toBeNull();
    });
    it("drops unsubscribed tracks", () => {
      const { room, result } = setup();
      emit(room, "sub", { kind: "video" }, {}, { identity: "cam" });
      emit(room, "sub", { kind: "audio" }, {}, { identity: "cam" });
      emit(room, "unsub", { kind: "video" }, {}, { identity: "cam" });
      emit(room, "unsub", { kind: "audio" }, {}, { identity: "cam" });
      emit(room, "unsub", { kind: "data" }, {}, { identity: "cam" });
      emit(room, "unsub", { kind: "video" }, {}, {});
      expect(result.current.getSourceState("cam")).toMatchObject({ videoTrack: null, audioTrack: null });
    });
    it("records subscription failures and disconnections", () => {
      const { room, result } = setup();
      emit(room, "fail", "SID1", { identity: "cam" }, "denied");
      expect(result.current.getSourceState("cam").error).toBe("Track subscription failed: denied");
      emit(room, "fail", "SID2", { identity: "cam" });
      expect(result.current.getSourceState("cam").error).toBe("Track subscription failed: SID2");
      emit(room, "fail", "SID3", {});
      emit(room, "sub", { kind: "video" }, {}, { identity: "cam" });
      emit(room, "gone", { identity: "cam" });
      expect(result.current.getSourceState("cam")).toMatchObject({ videoTrack: null, audioTrack: null, error: "Participant disconnected" });
      emit(room, "gone", {});
    });
    it("tracks the audio level of watched speakers", () => {
      const { room, result } = setup();
      emit(room, "speakers", [{ identity: "cam", audioLevel: 0.426 }, { identity: "cam" }, { identity: "nobody", audioLevel: 1 }, {}, null]);
      expect(result.current.getSourceState("cam").audioLevel).toBe(0);
      emit(room, "speakers", [{ identity: "cam", audioLevel: 0.426 }]);
      expect(result.current.getSourceState("cam").audioLevel).toBe(43);
      emit(room, "speakers", "nope");
    });
  });

  describe("useSourceSubscription", () => {
    it("subscribes while mounted, follows the source's state, and releases on unmount", () => {
      const room = fakeRoom();
      const vp = pub({ kind: "video" });
      room.remoteParticipants.set("cam", { trackPublications: new Map([["1", vp]]) });
      const { result, rerender, unmount } = renderHook(({ id }) => useSourceSubscription(id), { wrapper: wrapperFor(room), initialProps: { id: "cam" } });
      expect(result.current).toMatchObject({ isSubscribed: true, videoTrack: { kind: "video" } });
      emit(room, "speakers", [{ identity: "cam", audioLevel: 0.5 }]);
      expect(result.current.audioLevel).toBe(50);
      rerender({ id: "" });
      expect(result.current.participantIdentity).toBe("");
      rerender({ id: "cam" });
      unmount();
      expect(vp.setSubscribed).toHaveBeenLastCalledWith(false);
    });
    it("is reachable through the context", () => {
      const view = renderHook(() => useSourcesSubscriptionContext().useSourceSubscription("x"), { wrapper: wrapperFor(fakeRoom()) });
      expect(view.result.current.isSubscribed).toBe(true);
    });
  });
});
