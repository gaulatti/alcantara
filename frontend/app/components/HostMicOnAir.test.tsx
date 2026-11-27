import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostMicOnAir } from "./HostMicOnAir";

// The host's microphone on air: published as `onair:host` only to the station's contribution worker and the return
// router, off by default, and off again when switched off, when the page closes or when the room drops.

const lk = vi.hoisted(() => {
  const state = {
    rooms: [] as FakeRoom[],
    tracks: [] as { stopped: boolean }[],
    connect: async () => undefined as unknown,
  };
  class FakeRoom {
    handlers = new Map<string, () => void>();
    published: string[] = [];
    allowed: Array<{ all: boolean; identities: string[] }> = [];
    disconnected = false;
    connectedTo: string[] = [];
    localParticipant = {
      setTrackSubscriptionPermissions: (all: boolean, list: Array<{ participantIdentity: string; allowAll: boolean }>) => {
        this.allowed.push({ all, identities: list.map((entry) => entry.participantIdentity) });
      },
      publishTrack: async (_track: unknown, options: { name: string }) => {
        this.published.push(options.name);
      },
    };
    constructor() {
      state.rooms.push(this);
    }
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    }
    async connect(url: string, token: string) {
      await state.connect();
      this.connectedTo = [url, token];
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const createLocalAudioTrack = async () => {
    const track = { stopped: false, stop: () => (track.stopped = true) };
    state.tracks.push(track);
    return track;
  };
  return { state, FakeRoom, createLocalAudioTrack };
});
const api = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("livekit-client", () => ({
  Room: lk.FakeRoom,
  RoomEvent: { Disconnected: "disconnected" },
  createLocalAudioTrack: lk.createLocalAudioTrack,
}));
vi.mock("../services/api", () => api);

beforeEach(() => {
  lk.state.rooms = [];
  lk.state.tracks = [];
  lk.state.connect = async () => undefined;
  api.authFetch.mockReset().mockImplementation(async () => Response.json({ serverUrl: "wss://livekit.example", token: "fictional-operator-token" }));
});
afterEach(cleanup);

const offButton = () => screen.getByRole("button", { name: /^Mic on air$/ });
const onButton = () => screen.getByRole("button", { name: /ON AIR · Mic on air/ });

it("is off by default and needs permission to operate", () => {
  const view = render(<HostMicOnAir programId="modoitaliano.fm" canOperate={false} />);
  expect(offButton()).toBeDisabled();
  expect(offButton()).toHaveAttribute("aria-pressed", "false");
  view.rerender(<HostMicOnAir programId="modoitaliano.fm" canOperate />);
  expect(offButton()).toBeEnabled();
  expect(lk.state.rooms).toHaveLength(0);
});

it("publishes the host's mic as onair:host only to the contribution worker and the return router, then switches off", async () => {
  render(<HostMicOnAir programId="modoitaliano.fm" canOperate />);
  fireEvent.click(offButton());
  await waitFor(() => expect(onButton()).toHaveAttribute("aria-pressed", "true"));
  expect(api.authFetch).toHaveBeenCalledWith("/webrtc/operator-token", expect.objectContaining({ method: "POST", body: JSON.stringify({ programId: "modoitaliano.fm" }) }));
  const room = lk.state.rooms[0];
  expect(room.connectedTo).toEqual(["wss://livekit.example", "fictional-operator-token"]);
  expect(room.published).toEqual(["onair:host"]);
  expect(room.allowed).toEqual([{ all: false, identities: ["contribution-modoitaliano.fm", "return-router-modoitaliano.fm"] }]);
  fireEvent.click(onButton());
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(room.disconnected).toBe(true);
  expect(offButton()).toBeVisible();
});

it("leaves the air when the room drops, and says so", async () => {
  render(<HostMicOnAir programId="main" canOperate />);
  fireEvent.click(offButton());
  await waitFor(() => onButton());
  act(() => lk.state.rooms[0].handlers.get("disconnected")!());
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(offButton()).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("The host microphone left the air: the call room closed.");
});

it("says why it could not go on air and stays off", async () => {
  api.authFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  render(<HostMicOnAir programId="main" canOperate />);
  fireEvent.click(offButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("The host microphone could not join the call room.");
  expect(lk.state.rooms[0].disconnected).toBe(true);
  lk.state.connect = async () => {
    throw "refused";
  };
  fireEvent.click(offButton());
  expect(await screen.findByText("The host microphone could not go on air.")).toBeVisible();
});

it("closes the microphone when the page closes, also while it is still connecting", async () => {
  let connected: () => void = () => undefined;
  lk.state.connect = () => new Promise<undefined>((resolve) => (connected = () => resolve(undefined)));
  const view = render(<HostMicOnAir programId="main" canOperate />);
  fireEvent.click(offButton());
  await waitFor(() => expect(lk.state.rooms).toHaveLength(1));
  view.unmount();
  await act(async () => {
    connected();
  });
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(lk.state.rooms[0].published).toEqual([]);
  // A drop after the page closed changes nothing.
  lk.state.rooms[0].handlers.get("disconnected")?.();

  lk.state.connect = async () => undefined;
  const second = render(<HostMicOnAir programId="main" canOperate />);
  fireEvent.click(screen.getByRole("button", { name: /^Mic on air$/ }));
  await waitFor(() => onButton());
  second.unmount();
  expect(lk.state.tracks[1].stopped).toBe(true);
  expect(lk.state.rooms[1].disconnected).toBe(true);
});

it("stays quiet about a failure that arrives after the page moved on", async () => {
  let fail: (reason: unknown) => void = () => undefined;
  lk.state.connect = () => new Promise<undefined>((_resolve, reject) => (fail = reject));
  const view = render(<HostMicOnAir programId="main" canOperate />);
  fireEvent.click(offButton());
  await waitFor(() => expect(lk.state.rooms).toHaveLength(1));
  view.unmount();
  await act(async () => {
    fail(new Error("late"));
  });
  expect(screen.queryByRole("alert")).toBeNull();
});
