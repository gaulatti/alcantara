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
  // gaulatti/alcantara#879: a guest is let in and cued from the desk, not only from Guest calls.
  it("lists a waiting guest with Admit and no PFL, and gives each guest on the call the cue controls", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/webrtc/rooms/"))
        return Response.json({
          participants: [
            { identity: "guest-1", name: "Ada", connectionState: "connected", cueState: "standby" },
            { identity: "guest-3", name: "Lin", connectionState: "offline", screening: true, invitationId: "inv-3" },
          ],
        });
      throw new Error(`unexpected ${url}`);
    });
    render(<GuestPreListen programId="main" onActive={() => undefined} />);
    expect(await screen.findByText("Lin")).toBeVisible();
    expect(screen.getByText("Waiting to be let in")).toBeVisible();
    expect(screen.getByRole("button", { name: "Admit Lin" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pre-listen Lin" })).toBeNull();
    expect(screen.getByRole("group", { name: "Cue Ada" })).toBeVisible();
    expect(screen.getByText("Cue · standby")).toBeVisible();
    expect(screen.queryByText("No guest is connected.")).toBeNull();
  });

  it("reads the guest list again right after an Admit or a cue from the desk", async () => {
    vi.doMock("../../hooks/useFeatures", () => ({ useFeatures: () => ({ loading: false, hasPermission: () => true }) }));
    vi.resetModules();
    const { GuestPreListen: Fresh } = await import("./GuestPreListen");
    const reads = () => authFetch.mock.calls.filter(([url]) => String(url).startsWith("/webrtc/rooms/") && !String(url).includes("/control")).length;
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/webrtc/rooms/") && !url.includes("/control"))
        return Response.json({
          participants: [
            { identity: "guest-1", name: "Ada", connectionState: "connected", cueState: "standby" },
            { identity: "guest-3", name: "Lin", connectionState: "offline", screening: true, invitationId: "inv-3" },
          ],
        });
      return Response.json({});
    });
    render(<Fresh programId="main" onActive={() => undefined} />);
    await screen.findByText("Lin");
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: "Admit Lin" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    fireEvent.click(screen.getByRole("button", { name: "Standby" }));
    await waitFor(() => expect(reads()).toBe(before + 2));
    vi.doUnmock("../../hooks/useFeatures");
  });

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

// A show switch replaces the list; a read still in flight for the previous show reaches neither it nor the strip.
it("drops a read that answers after the desk it was made for is gone", async () => {
  let release!: (response: Response) => void;
  authFetch.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
  const onGuests = vi.fn();
  const view = render(<GuestPreListen programId="one" onActive={() => {}} onGuests={onGuests} />);
  view.unmount();
  await act(async () => release(new Response(JSON.stringify({ participants: [{ identity: "guest-1", name: "Ada", connectionState: "connected" }] }))));
  expect(onGuests).not.toHaveBeenCalled();
});
