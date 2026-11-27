import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestPreListen } from "./GuestPreListen";

// The guest list on the radio desk (gaulatti/alcantara#835): selecting a guest joins the operator's room with
// autoSubscribe off, subscribes to that guest's microphone, and publishes nothing.
const lk = vi.hoisted(() => {
  const state = {
    connects: [] as unknown[][],
    publishes: 0,
    subscribed: [] as boolean[],
    attached: 0,
    disconnects: 0,
  };
  return { state };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  class FakeRoom {
    remoteParticipants = new Map([
      [
        "guest-1",
        {
          identity: "guest-1",
          trackPublications: new Map([
            [
              "mic",
              {
                kind: "audio",
                source: "microphone",
                track: {
                  attach: () => {
                    lk.state.attached += 1;
                    return { muted: true };
                  },
                  detach: () => undefined,
                },
                setSubscribed: (value: boolean) => lk.state.subscribed.push(value),
              },
            ],
          ]),
        },
      ],
    ]);
    on = vi.fn();
    off = vi.fn();
    disconnect = () => {
      lk.state.disconnects += 1;
    };
    localParticipant = {
      publishTrack: () => (lk.state.publishes += 1),
      setMicrophoneEnabled: () => (lk.state.publishes += 1),
      setCameraEnabled: () => (lk.state.publishes += 1),
    };
    async connect(...args: unknown[]) {
      lk.state.connects.push(args);
    }
  }
  return { ...actual, Room: FakeRoom };
});

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../../services/api", () => ({ authFetch }));

function answer() {
  authFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/webrtc/rooms/")) {
      return new Response(
        JSON.stringify({
          participants: [
            { identity: "guest-1", name: "Ada", connectionState: "connected" },
            { identity: "guest-2", name: "Grace", connectionState: "offline" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/webrtc/operator-token") {
      return new Response(JSON.stringify({ serverUrl: "wss://live.example.test", token: "fictional-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  lk.state.connects = [];
  lk.state.publishes = 0;
  lk.state.subscribed = [];
  lk.state.attached = 0;
  lk.state.disconnects = 0;
  authFetch.mockReset();
  answer();
});

afterEach(() => {
  cleanup();
});

describe("GuestPreListen", () => {
  it("lists the connected guests only, with a PFL button for each", async () => {
    render(<GuestPreListen programId="main" onActive={() => undefined} />);
    expect(await screen.findByText("Ada")).toBeVisible();
    expect(screen.queryByText("Grace")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pre-listen Ada" })).toBeEnabled();
  });

  it("joins the room without autoSubscribe, subscribes to the guest's microphone, and publishes nothing", async () => {
    const onActive = vi.fn();
    render(<GuestPreListen programId="main" onActive={onActive} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pre-listen Ada" }));

    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    expect(lk.state.connects).toEqual([["wss://live.example.test", "fictional-token", { autoSubscribe: false }]]);
    expect(lk.state.attached).toBe(1);
    expect(lk.state.publishes).toBe(0);
    expect(authFetch).toHaveBeenCalledWith(
      "/webrtc/operator-token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ programId: "main" }) }),
    );
    expect(onActive).toHaveBeenCalledWith("guest", true);
    expect(await screen.findByRole("status")).toHaveTextContent("PFL · Ada · this device only");
  });

  it("stops when the same guest's button is pressed again", async () => {
    const onActive = vi.fn();
    render(<GuestPreListen programId="main" onActive={onActive} />);
    const button = await screen.findByRole("button", { name: "Pre-listen Ada" });
    fireEvent.click(button);
    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    fireEvent.click(button);
    await waitFor(() => expect(lk.state.subscribed).toEqual([true, false]));
    expect(onActive).toHaveBeenLastCalledWith("guest", false);
    expect(lk.state.publishes).toBe(0);
  });

  it("stops on Escape", async () => {
    render(<GuestPreListen programId="main" onActive={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pre-listen Ada" }));
    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(lk.state.subscribed).toEqual([true, false]));
  });

  it("says so when the studio room cannot be joined", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/webrtc/rooms/")) {
        return new Response(JSON.stringify({ participants: [{ identity: "guest-1", name: "Ada", connectionState: "connected" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 403 });
    });
    render(<GuestPreListen programId="main" onActive={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pre-listen Ada" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The studio room is not available for listening.");
    expect(lk.state.subscribed).toEqual([]);
  });

  it("claims the desk when started, and leaves the room when stopped", async () => {
    const onActive = vi.fn();
    render(<GuestPreListen programId="main" onActive={onActive} />);
    const button = await screen.findByRole("button", { name: "Pre-listen Ada" });
    fireEvent.click(button);
    expect(onActive).toHaveBeenCalledWith("guest", true);
    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    fireEvent.click(button);
    await waitFor(() => expect(lk.state.disconnects).toBe(1));
    expect(onActive).toHaveBeenLastCalledWith("guest", false);
  });

  it("stops when another pre-fade takes the desk, and leaves the room", async () => {
    const { rerender } = render(<GuestPreListen programId="main" onActive={() => undefined} activeOwner={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pre-listen Ada" }));
    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    rerender(<GuestPreListen programId="main" onActive={() => undefined} activeOwner="song" />);
    await waitFor(() => expect(lk.state.subscribed).toEqual([true, false]));
    await waitFor(() => expect(lk.state.disconnects).toBe(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("leaves the room when the desk unmounts while listening", async () => {
    const view = render(<GuestPreListen programId="main" onActive={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pre-listen Ada" }));
    await waitFor(() => expect(lk.state.subscribed).toEqual([true]));
    view.unmount();
    expect(lk.state.disconnects).toBeGreaterThanOrEqual(1);
    expect(lk.state.subscribed).toEqual([true, false]);
  });
});
