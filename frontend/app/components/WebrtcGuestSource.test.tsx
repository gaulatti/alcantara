import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lk = vi.hoisted(() => {
  const rooms: any[] = [];
  class Room {
    handlers: Record<string, (...a: any[]) => void> = {};
    remoteParticipants = new Map<string, any>();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    options: any;
    constructor(options: any) {
      this.options = options;
      rooms.push(this);
    }
    on(event: string, handler: (...a: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
  }
  return {
    rooms,
    Room,
    ConnectionState: { Disconnected: "disconnected", Connected: "connected" },
    RoomEvent: {
      ConnectionStateChanged: "state",
      TrackSubscribed: "sub",
      TrackUnsubscribed: "unsub",
      ParticipantConnected: "pc",
      ParticipantDisconnected: "pd",
    },
    Track: { Kind: { Video: "video", Audio: "audio" } },
  };
});
vi.mock("livekit-client", () => lk);
vi.mock("../utils/apiBaseUrl", () => ({ apiUrl: (p: string) => `http://api.test${p}` }));

import { WebrtcGuestSource } from "./WebrtcGuestSource";

const room = () => lk.rooms[lk.rooms.length - 1];
const participant = (slot: number | null, identity = "guest-1", tracks: any[] = []) => ({
  identity,
  metadata: slot === null ? "{broken" : JSON.stringify({ slotNumber: slot }),
  trackPublications: new Map(tracks.map((t, i) => [String(i), { track: t }])),
});
const track = (kind: string) => ({ kind, attach: vi.fn(), detach: vi.fn() });
const fetchMock = vi.fn();
const flush = () => act(async () => {});
const credentials = { serverUrl: "wss://lk.test", token: "tok" };

beforeEach(() => {
  lk.rooms.length = 0;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => credentials });
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/#key=renderer-key");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("WebrtcGuestSource", () => {
  it("authorises with the renderer key and connects with the issued credentials", async () => {
    render(<WebrtcGuestSource programId="prog" />);
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/webrtc/renderer-source-token");
    expect(init.headers["X-Renderer-Key"]).toBe("renderer-key");
    expect(JSON.parse(init.body)).toEqual({ programId: "prog" });
    expect(room().options).toEqual({ adaptiveStream: true, dynacast: false });
    expect(room().connect).toHaveBeenCalledWith("wss://lk.test", "tok", { autoSubscribe: true });
    expect(window.sessionStorage.getItem("alcantara-renderer-key")).toBe("renderer-key");
  });
  it("reuses the stored renderer key, and fails without one", async () => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.setItem("alcantara-renderer-key", "stored");
    render(<WebrtcGuestSource programId="p" />);
    await flush();
    expect(fetchMock.mock.calls[0][1].headers["X-Renderer-Key"]).toBe("stored");
    cleanup();
    window.sessionStorage.clear();
    fetchMock.mockClear();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<WebrtcGuestSource programId="p" />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("WebRTC guest slot failed:", expect.objectContaining({ message: "Renderer source credential is missing." }));
  });
  it("shows the connecting state, then the offline slot once connected without a guest", async () => {
    render(<WebrtcGuestSource programId="p" slotNumber={3} />);
    await flush();
    expect(screen.getByText("Connecting guest source")).toBeInTheDocument();
    act(() => room().handlers.state("connected"));
    expect(screen.getByText("Guest slot 3 offline")).toBeInTheDocument();
  });
  it("hides the status when asked, and clamps the slot, gain and fit", async () => {
    const { container } = render(<WebrtcGuestSource programId="p" slotNumber={9} showStatus={false} objectFit="contain" channelGain={5} />);
    await flush();
    expect(screen.queryByText("Connecting guest source")).toBeNull();
    expect(container.querySelector("video")!.style.objectFit).toBe("contain");
    expect(container.querySelector("audio")!.volume).toBe(1);
    cleanup();
    const quiet = render(<WebrtcGuestSource programId="p" slotNumber="x" channelGain={-3} />);
    await flush();
    expect(quiet.container.querySelector("video")!.style.objectFit).toBe("cover");
    expect(quiet.container.querySelector("audio")!.muted).toBe(true);
    act(() => room().handlers.state("connected"));
    expect(screen.getByText("Guest slot 1 offline")).toBeInTheDocument();
  });
  it("silences the audio element while suppressed, and defaults a bad gain to full", async () => {
    const { container, rerender } = render(<WebrtcGuestSource programId="p" suppressAudio channelGain={Number.NaN} />);
    await flush();
    const audio = container.querySelector("audio")!;
    expect(audio.volume).toBe(0);
    expect(audio.muted).toBe(true);
    rerender(<WebrtcGuestSource programId="p" channelGain={Number.NaN} />);
    expect(audio.volume).toBe(1);
    expect(audio.muted).toBe(false);
  });
  it("attaches the matching guest's tracks and reports it online", async () => {
    const { container } = render(<WebrtcGuestSource programId="p" slotNumber={2} />);
    await flush();
    const video = track("video");
    const audio = track("audio");
    act(() => room().handlers.state("connected"));
    act(() => room().handlers.sub(video, {}, participant(2)));
    act(() => room().handlers.sub(audio, {}, participant(2)));
    expect(video.attach).toHaveBeenCalledWith(container.querySelector("video"));
    expect(audio.attach).toHaveBeenCalledWith(container.querySelector("audio"));
    expect(screen.queryByText(/offline/)).toBeNull();
  });
  it("ignores other slots, non-guests and unreadable metadata", async () => {
    render(<WebrtcGuestSource programId="p" slotNumber={2} />);
    await flush();
    const video = track("video");
    for (const p of [participant(4), participant(2, "host-1"), participant(null)]) room().handlers.sub(video, {}, p);
    room().handlers.unsub(video, {}, participant(4));
    expect(video.attach).not.toHaveBeenCalled();
    expect(video.detach).not.toHaveBeenCalled();
  });
  it("refreshes when participants come and go, attaching existing tracks and detaching removed ones", async () => {
    render(<WebrtcGuestSource programId="p" slotNumber={2} />);
    await flush();
    act(() => room().handlers.state("connected"));
    const video = track("video");
    const guest = participant(2, "guest-9", [video, { ...track("other"), kind: "data" }]);
    guest.trackPublications.set("none", { track: undefined } as any);
    room().remoteParticipants.set("a", participant(5));
    room().remoteParticipants.set("b", guest);
    act(() => room().handlers.pc());
    expect(video.attach).toHaveBeenCalled();
    expect(screen.queryByText(/offline/)).toBeNull();
    room().remoteParticipants.delete("b");
    act(() => room().handlers.unsub(video, {}, guest));
    expect(video.detach).toHaveBeenCalled();
    expect(screen.getByText("Guest slot 2 offline")).toBeInTheDocument();
    act(() => room().handlers.pd());
  });
  it("finds a guest already present once connected, unless it was cancelled", async () => {
    render(<WebrtcGuestSource programId="p" />);
    room().remoteParticipants.set("a", participant(1));
    await flush();
    act(() => room().handlers.state("connected"));
    expect(screen.queryByText(/offline/)).toBeNull();
  });
  it("reports authorisation and connection failures as disconnected", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    render(<WebrtcGuestSource programId="p" />);
    await flush();
    expect(error).toHaveBeenCalledWith("WebRTC guest slot failed:", expect.objectContaining({ message: "Guest source authorization failed (403)." }));
    expect(screen.getByText("Connecting guest source")).toBeInTheDocument();
  });
  it("disconnects on unmount and never connects if the authorisation returns afterwards", async () => {
    let release!: (v: any) => void;
    fetchMock.mockReturnValue(new Promise((r) => (release = r)));
    const view = render(<WebrtcGuestSource programId="p" />);
    view.unmount();
    expect(room().disconnect).toHaveBeenCalled();
    await act(async () => release({ ok: true, status: 200, json: async () => credentials }));
    expect(room().connect).not.toHaveBeenCalled();
  });
  it("ignores a connect that settles after unmount", async () => {
    let finish!: () => void;
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => credentials });
    const view = render(<WebrtcGuestSource programId="p" />);
    const r = room();
    r.connect.mockReturnValue(new Promise<void>((res) => (finish = res)));
    await waitFor(() => expect(r.connect).toHaveBeenCalled());
    view.unmount();
    await act(async () => finish());
    const failing = render(<WebrtcGuestSource programId="p" />);
    const r2 = room();
    let fail!: (e: Error) => void;
    r2.connect.mockReturnValue(new Promise<void>((_, rej) => (fail = rej)));
    await waitFor(() => expect(r2.connect).toHaveBeenCalled());
    failing.unmount();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => fail(new Error("late")));
  });
});
