import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostMicOnAir, HostMicProvider, useHostMic } from "./HostMicOnAir";
import { DeskHostMic } from "./radio-desk/DeskHostMic";

// gaulatti/alcantara#879: the microphone stays live while the operator moves between pages, so the song clock and the
// dead-air warning stay in view while they talk. It still goes off when the studio mutes it and when the show changes.
const lk = vi.hoisted(() => {
  const state = { rooms: [] as FakeRoom[], tracks: [] as { stopped: boolean }[] };
  class FakeRoom {
    handlers = new Map<string, (...args: any[]) => void>();
    published: string[] = [];
    disconnected = false;
    localParticipant = {
      setTrackSubscriptionPermissions: () => {},
      publishTrack: async (_track: unknown, options: { name: string }) => void this.published.push(options.name),
    };
    constructor() {
      state.rooms.push(this);
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }
    async connect() {}
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
vi.mock("livekit-client", () => ({
  Room: lk.FakeRoom,
  RoomEvent: { Disconnected: "disconnected", TrackMuted: "trackMuted" },
  Track: { Source: { Microphone: "microphone", Camera: "camera" } },
  createLocalAudioTrack: lk.createLocalAudioTrack,
}));
vi.mock("../services/api", () => ({ authFetch: vi.fn(async () => Response.json({ serverUrl: "wss://livekit.example", token: "t" })) }));

const permitted = vi.hoisted(() => ({ operate: true }));
vi.mock("../hooks/useFeatures", () => ({ useFeatures: () => ({ hasPermission: () => permitted.operate, loading: false }) }));

afterEach(() => {
  cleanup();
  permitted.operate = true;
  lk.state.rooms.length = 0;
  lk.state.tracks.length = 0;
});

function State() {
  const mic = useHostMic()!;
  return <p data-testid="state">{`${mic.state} ${mic.programId}`}</p>;
}
const consoleWith = (show: string, page: "calls" | "desk" | "library") => (
  <HostMicProvider programId={show}>
    <State />
    {page === "library" ? <p>Library</p> : <HostMicOnAir key={page} programId={show} canOperate />}
  </HostMicProvider>
);
async function goOnAir() {
  fireEvent.click(screen.getByRole("button", { name: "Mic on air" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /ON AIR/ })).toBeVisible());
}

it("stays on air from one page to another, and shows on air where it has a button", async () => {
  const view = render(consoleWith("radio one", "calls"));
  await goOnAir();
  view.rerender(consoleWith("radio one", "library"));
  expect(screen.getByTestId("state")).toHaveTextContent("on radio one");
  expect(lk.state.rooms[0].disconnected).toBe(false);
  view.rerender(consoleWith("radio one", "desk"));
  expect(screen.getByRole("button", { name: /ON AIR/ })).toBeVisible();
  expect(lk.state.rooms).toHaveLength(1);
  expect(lk.state.tracks[0].stopped).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /ON AIR/ }));
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(lk.state.rooms[0].disconnected).toBe(true);
});

it("still follows a mute from the studio after the page changed", async () => {
  const view = render(consoleWith("radio one", "calls"));
  await goOnAir();
  view.rerender(consoleWith("radio one", "desk"));
  act(() => lk.state.rooms[0].handlers.get("trackMuted")!({ source: "microphone", isMuted: true }, { isLocal: true }));
  expect(screen.getByTestId("state")).toHaveTextContent("off");
  expect(screen.getByRole("alert")).toHaveTextContent("The studio muted the host microphone. It is off air.");
  expect(lk.state.tracks[0].stopped).toBe(true);
});

it("goes off air when the show changes, and when the console is left", async () => {
  const view = render(consoleWith("radio one", "desk"));
  await goOnAir();
  view.rerender(consoleWith("radio two", "desk"));
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("off"));
  expect(screen.getByRole("alert")).toHaveTextContent("because the show changed");
  expect(lk.state.tracks[0].stopped).toBe(true);
  await goOnAir();
  view.unmount();
  expect(lk.state.tracks[1].stopped).toBe(true);
  expect(lk.state.rooms[1].disconnected).toBe(true);
});

it("is on the radio desk only inside the console, and refused without the permission", () => {
  expect(render(<DeskHostMic programId="radio one" />).container).toBeEmptyDOMElement();
  cleanup();
  permitted.operate = false;
  render(
    <HostMicProvider programId="radio one">
      <DeskHostMic programId="radio one" />
    </HostMicProvider>,
  );
  expect(screen.getByRole("button", { name: "Mic on air" })).toBeDisabled();
});

it("opens one room and publishes one track, only on a press", async () => {
  let start!: (show: string) => Promise<void>;
  function Press() {
    start = useHostMic()!.start;
    return null;
  }
  const view = render(
    <HostMicProvider programId="radio one">
      <Press />
      <HostMicOnAir programId="radio one" canOperate />
    </HostMicProvider>,
  );
  view.rerender(
    <HostMicProvider programId="radio one">
      <Press />
      <HostMicOnAir key="again" programId="radio one" canOperate />
    </HostMicProvider>,
  );
  expect(lk.state.rooms).toHaveLength(0);
  await act(async () => {
    await Promise.all([start("radio one"), start("radio one")]);
  });
  await act(async () => start("radio one"));
  expect(lk.state.rooms).toHaveLength(1);
  expect(lk.state.rooms[0].published).toEqual(["onair:host"]);
});
