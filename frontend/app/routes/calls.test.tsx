import {
  act,  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CallsRoute, { meta } from "./calls";
import { routeFetch } from "../../test/routeKit";

// Guest calls: private invitation links, return routing and studio controls
// for remote contributors. LiveKit is a stand-in that records the talkback.

const lk = vi.hoisted(() => {
  const state = {
    rooms: [] as {
      connectedTo: string[];
      published: string[];
      disconnected: boolean;
      allowed: Array<{ all: boolean; identities: string[]; beforePublish: boolean }>;
    }[],
    tracks: [] as { stopped: boolean }[],
    // Set by a test to make the next connect fail with this value.
    failConnectWith: null as unknown,
  };
  class Room {
    connectedTo: string[] = [];
    published: string[] = [];
    disconnected = false;
    // Who may receive this room's tracks, as set before each publish.
    allowed: Array<{ all: boolean; identities: string[]; beforePublish: boolean }> = [];
    localParticipant = {
      setTrackSubscriptionPermissions: (
        all: boolean,
        list: Array<{ participantIdentity: string; allowAll: boolean }>,
      ) => {
        this.allowed.push({
          all,
          identities: list.filter((entry) => entry.allowAll).map((entry) => entry.participantIdentity),
          beforePublish: this.published.length === 0,
        });
      },
      publishTrack: async (_track: unknown, options: { name: string }) => {
        this.published.push(options.name);
      },
    };
    constructor() {
      state.rooms.push(this);
    }
    async connect(url: string, token: string) {
      if (state.failConnectWith !== null) {
        const failure = state.failConnectWith;
        state.failConnectWith = null;
        throw failure;
      }
      this.connectedTo = [url, token];
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const createLocalAudioTrack = async () => {
    const track = {
      stopped: false,
      stop() {
        track.stopped = true;
      },
    };
    state.tracks.push(track);
    return track;
  };
  return { state, Room, createLocalAudioTrack };
});
const permissions = vi.hoisted(() => ({ operate: true, loading: false }));

vi.mock("livekit-client", () => ({
  Room: lk.Room,
  createLocalAudioTrack: lk.createLocalAudioTrack,
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ hasPermission: () => permissions.operate, loading: permissions.loading }),
}));
const shown = vi.hoisted(() => ({ program: "main show" }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [shown.program],
}));
const api = vi.hoisted(() => ({
  handler: null as
    | null
    | ((url: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("../services/api", () => ({
  authFetch: (path: string, init?: RequestInit) =>
    api.handler!(`https://api.example${path}`, init),
}));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

const invitation = (overrides: Record<string, unknown> = {}) => ({
  id: "inv-1",
  programId: "main show",
  displayName: "Ada",
  slotNumber: 1,
  returnVideo: "program",
  returnAudioBus: "master",
  sourceGain: 1,
  sourceMuted: false,
  sourceDelayMs: 0,
  expiresAt: "2026-11-18T10:00:00.000Z",
  status: "active",
  ...overrides,
});
const participant = (overrides: Record<string, unknown> = {}) => ({
  invitationId: "inv-1",
  identity: "guest-ada",
  name: "Ada",
  slotNumber: 1,
  connectionState: "connected",
  returnVideo: "program",
  returnAudioBus: "master",
  sourceGain: 1,
  sourceMuted: false,
  sourceDelayMs: 0,
  tracks: [
    { sid: "m1", source: "microphone", muted: false },
    { sid: "c1", source: "camera", muted: true },
  ],
  commands: [
    { id: "c", type: "cue", status: "delivered", payload: {}, createdAt: "" },
  ],
  ...overrides,
});

let config: unknown;
let invitations: unknown[];
let participants: unknown[];
let room: unknown;

function serve(
  overrides: Partial<Record<string, (init?: RequestInit) => Response>> = {},
) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${decodeURIComponent(new URL(url).pathname)}`;
    if (overrides[key]) return overrides[key]!(init);
    if (key === "GET /webrtc/config") return Response.json(config);
    if (key === "GET /webrtc/invitations") return Response.json(invitations);
    if (key === "GET /webrtc/rooms/main show/participants")
      return Response.json({ room, participants });
    if (key === "POST /webrtc/invitations")
      return Response.json({
        ...invitation({ id: "inv-2", slotNumber: 2 }),
        invitationPath: "/guest/secret-2",
      });
    if (key === "POST /webrtc/invitations/inv-1/replace")
      return Response.json({
        ...invitation(),
        invitationPath: "/guest/secret-1b",
      });
    if (key === "POST /webrtc/operator-token")
      return Response.json({
        serverUrl: "wss://livekit.example",
        token: "fictional-operator-token",
      });
    if (["DELETE", "PATCH", "POST"].includes(method))
      return new Response(null, { status: 204 });
    throw new Error(`unexpected ${key}`);
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  api.handler = fetchMock;
  return calls;
}

const status = () => screen.getByRole("status");
// Each guest is a channel strip on the caller desk (alcantara#301).
const card = () => screen.getByRole("article", { name: /: Ada$/ });
const button = (name: RegExp | string) =>
  within(card()).getByRole("button", { name });
/** The routing toggle sits inside its field label, so find it by its text. */
const routing = (text: RegExp) =>
  within(card()).getByText(text).closest("button") as HTMLButtonElement;
const bodyOf = (
  calls: { url: string; init: RequestInit | undefined }[],
  suffix: string,
) =>
  JSON.parse(
    String(
      calls
        .filter(
          (call) => call.init?.body !== undefined && call.url.endsWith(suffix),
        )
        .at(-1)!.init!.body,
    ),
  );

beforeEach(() => {
  shown.program = "main show";
  permissions.operate = true;
  config = { enabled: true };
  invitations = [
    invitation(),
    invitation({ id: "inv-x", programId: "other show" }),
  ];
  participants = [participant()];
  room = { returnSending: false, returnParticipant: null };
  lk.state.rooms = [];
  lk.state.tracks = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("has a page title", () => {
  expect(meta({} as never)).toEqual([{ title: "Guest Calls - Alcántara" }]);
});

it("explains that LiveKit is not configured", async () => {
  config = {};
  const calls = serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Guest calls need LiveKit")).toBeVisible();
  expect(screen.getByText(/alcantara#51/)).toBeVisible();
  expect(calls.some((call) => call.url.includes("/invitations"))).toBe(false);
});

it.each([
  [
    "GET /webrtc/config",
    () => Response.json({ message: "Config unavailable" }, { status: 503 }),
    "Config unavailable",
  ],
  [
    "GET /webrtc/invitations",
    () => new Response("not json", { status: 500 }),
    "not json",
  ],
  [
    "GET /webrtc/rooms/main show/participants",
    () => new Response("", { status: 502 }),
    "Request failed (502)",
  ],
])(
  "explains a call list that cannot be loaded without showing the server's text (%s)",
  async (route, answer, serverText) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    serve({ [route]: answer });
    render(<CallsRoute />);
    expect(await screen.findByText("Guest calls could not be loaded")).toBeVisible();
    expect(
      screen.getByText(
        "The guest-call list could not be loaded. Check the connection and try again.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(serverText)).not.toBeInTheDocument();
  },
);

it("names the control plane when it cannot be reached, not a raw fetch error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  render(<CallsRoute />);
  expect(
    await screen.findByText("The guest-call control plane can't be reached. Guests can't join until it is back."),
  ).toBeVisible();
  expect(screen.queryByText("fetch failed")).not.toBeInTheDocument();
});

it("explains a failure that is not an error object", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
  render(<CallsRoute />);
  expect(await screen.findByText("Guest calls could not be loaded")).toBeVisible();
});

it("shows this program's slots and each guest's state", async () => {
  invitations = [
    invitation(),
    invitation({ id: "inv-gone", status: "revoked" }),
    invitation({ id: "inv-old", status: "expired" }),
  ];
  participants = [
    participant(),
    participant({ invitationId: "unknown", identity: "ghost", name: "Ghost" }),
  ];
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
  expect(screen.getByText("1/6 slots assigned")).toBeVisible();
  // A participant without an invitation of this program is not shown.
  expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
  expect(within(card()).getByText("Live")).toBeVisible();
  expect(within(card()).getByText("Latest cue:")).toBeVisible();
  expect(button(/Request camera/)).toBeEnabled();
  expect(button(/Mute mic/)).toBeEnabled();
  expect(routing(/Routed to returns/)).toBeEnabled();
});

it("says whether the studio's return is sending to guests", async () => {
  room = { returnSending: true, returnParticipant: "renderer-main-7f3a" };
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Return to guests: sending (program audio)")).toBeVisible();
});

it("says the return is not sending when no return router is in the room", async () => {
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Return to guests: not sending")).toBeVisible();
});

it("says the return is unknown when the studio reports no room state", async () => {
  room = undefined;
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Return to guests: unknown")).toBeVisible();
});

it("shows what the producer needs: 'Hears the studio' when playing, a warning when stalled, nothing while connecting", async () => {
  invitations = [
    invitation(),
    invitation({ id: "inv-2", displayName: "Grace", slotNumber: 2 }),
    invitation({ id: "inv-3", displayName: "Linus", slotNumber: 3 }),
  ];
  participants = [
    participant({ returnReaching: "healthy" }),
    participant({ invitationId: "inv-2", identity: "guest-inv-2", name: "Grace", slotNumber: 2, returnReaching: "stalled" }),
    participant({ invitationId: "inv-3", identity: "guest-inv-3", name: "Linus", slotNumber: 3, returnReaching: "missing" }),
  ];
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Hears the studio")).toBeVisible();
  expect(screen.getByText("Studio sound not reaching guest")).toBeVisible();
  // Linus is still connecting: nothing extra is shown for him.
  const linus = screen.getByRole("article", { name: /: Linus$/ });
  expect(within(linus).queryByText("Hears the studio")).not.toBeInTheDocument();
  expect(within(linus).queryByText("Studio sound not reaching guest")).not.toBeInTheDocument();
});

it("shows an empty room with the create action inside it, and says why it is disabled", async () => {
  participants = [];
  invitations = [];
  serve();
  render(<CallsRoute />);
  const empty = (await screen.findByText("No assigned guest slots")).closest(
    "div",
  )!.parentElement as HTMLElement;
  const create = within(empty).getByRole("button", {
    name: /Create private link/,
  });
  expect(create).toBeDisabled();
  expect(
    screen.getAllByText("Enter a guest name to create a private link.")[0],
  ).toBeVisible();
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  expect(create).toBeEnabled();
  expect(
    screen.queryByText("Enter a guest name to create a private link."),
  ).not.toBeInTheDocument();
});

it("says why creating a link is disabled: no permission, or every slot assigned", async () => {
  permissions.operate = false;
  serve();
  const { unmount } = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(
    screen.getByText("You do not have permission to create guest links."),
  ).toBeVisible();
  unmount();
  permissions.operate = true;
  invitations = Array.from({ length: 6 }, (_, index) =>
    invitation({ id: `inv-${index + 1}` }),
  );
  render(<CallsRoute />);
  await screen.findByText("6/6 slots assigned");
  expect(
    screen.getByText("All 6 guest slots are assigned. Revoke a link to free one."),
  ).toBeVisible();
});

it("does not say the operator lacks permission while the permissions are still loading", async () => {
  permissions.loading = true;
  try {
    serve();
    render(<CallsRoute />);
    expect(await screen.findByText("Checking your permissions…")).toBeVisible();
    expect(screen.queryByText("You do not have permission to create guest links.")).not.toBeInTheDocument();
  } finally {
    permissions.loading = false;
  }
});

it("shows loading as skeletons until the first list arrives", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { fetchMock } = routeFetch(async (url) => {
    await gate;
    if (url.endsWith("/webrtc/config")) return Response.json(config);
    if (url.endsWith("/webrtc/invitations")) return Response.json(invitations);
    return Response.json({ participants });
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  api.handler = fetchMock;
  render(<CallsRoute />);
  expect(screen.getByLabelText("Loading guest slots")).toBeVisible();
  release();
  expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
  expect(screen.queryByLabelText("Loading guest slots")).not.toBeInTheDocument();
});

it("offers a retry when the first load fails, and shows the list after it", async () => {
  serve({ "GET /webrtc/config": () => new Response("", { status: 503 }) });
  render(<CallsRoute />);
  expect(await screen.findByText("Guest calls could not be loaded")).toBeVisible();
  serve();
  fireEvent.click(screen.getByText("Retry").closest("button")!);
  expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
});

it("reports a manual refresh that fails", async () => {
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  serve({ "GET /webrtc/config": () => new Response("down", { status: 500 }) });
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await waitFor(() =>
    expect(status()).toHaveTextContent("Guest calls could not be refreshed."),
  );
  expect(status()).not.toHaveTextContent("down");
});

it("creates a private link for a named guest and copies it", async () => {
  const calls = serve();
  const writeText = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText, write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly items: Record<string, unknown>) {}
    },
  );
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const create = screen.getByRole("button", { name: /Create private link/ });
  expect(create).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  fireEvent.change(screen.getByDisplayValue("24 hours (default)"), {
    target: { value: "72" },
  });
  fireEvent.click(create);
  expect(
    await screen.findByText("Guest slot 2 is ready. The private link is copied: send it to the guest."),
  ).toBeVisible();
  expect(bodyOf(calls, "/webrtc/invitations")).toEqual({
    programId: "main show",
    displayName: "Grace",
    expiresInHours: 72,
  });
  const url = `${window.location.origin}/guest/secret-2`;
  expect(screen.getByText(url)).toBeVisible();
  expect(screen.getByPlaceholderText("Fictional guest")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: /Copy invitation/ }));
  await waitFor(() =>
    expect(status()).toHaveTextContent("Private invitation copied."),
  );
  expect(writeText).toHaveBeenCalledWith(url);
});

it("keeps the new link on screen when the browser refuses the copy", async () => {
  const calls = serve();
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create private link/ }));
  expect(
    await screen.findByText(
      "Guest slot 2 is ready. Copy the private link below and send it to the guest.",
    ),
  ).toBeVisible();
  expect(screen.getByText(`${window.location.origin}/guest/secret-2`)).toBeVisible();
  expect(bodyOf(calls, "/webrtc/invitations")).toMatchObject({ displayName: "Grace" });
});

it("blocks a seventh slot", async () => {
  invitations = Array.from({ length: 6 }, (_, index) =>
    invitation({ id: `inv-${index + 1}` }),
  );
  serve();
  render(<CallsRoute />);
  await screen.findByText("6/6 slots assigned");
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  expect(
    screen.getByRole("button", { name: /Create private link/ }),
  ).toBeDisabled();
});

it("explains an invitation that could not be created, and an action failure that is not an error", async () => {
  serve({
    "POST /webrtc/invitations": () =>
      Response.json({ message: "No free slot" }, { status: 409 }),
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create private link/ }));
  expect(await screen.findByText("No free slot")).toBeVisible();

  serve({
    "POST /webrtc/invitations": () => {
      throw "offline";
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create private link/ }));
  expect(await screen.findByText("Action failed.")).toBeVisible();
});

it("changes each return setting, keeping the others", async () => {
  const calls = serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const [video, audio, gain, delay] = within(card()).getAllByRole("combobox");
  const base = {
    returnVideo: "program",
    returnAudioBus: "master",
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
  };
  for (const [control, value, field, expected] of [
    [video, "preview", "returnVideo", "preview"],
    [audio, "aux-3", "returnAudioBus", "aux-3"],
    [gain, "0.5", "sourceGain", 0.5],
    [delay, "300", "sourceDelayMs", 300],
  ] as const) {
    fireEvent.change(control, { target: { value } });
    await waitFor(() =>
      expect(bodyOf(calls, "/webrtc/invitations/inv-1/return")).toEqual({
        ...base,
        [field]: expected,
      }),
    );
  }
  fireEvent.click(routing(/Routed to returns/));
  await waitFor(() =>
    expect(bodyOf(calls, "/webrtc/invitations/inv-1/return")).toEqual({
      ...base,
      sourceMuted: true,
    }),
  );
  serve({
    "PATCH /webrtc/invitations/inv-1/return": () =>
      new Response("Locked", { status: 423 }),
  });
  fireEvent.click(routing(/Routed to returns/));
  expect(await screen.findByText("Locked")).toBeVisible();
});

it("sends media, cue and message commands to the guest", async () => {
  const calls = serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const control = "/webrtc/rooms/main show/participants/guest-ada/control";
  fireEvent.click(button(/Request camera/));
  const sent = () =>
    calls
      .filter((call) => decodeURIComponent(call.url).endsWith(control))
      .map((call) => JSON.parse(String(call.init!.body)));
  await waitFor(() =>
    expect(sent()).toEqual([
      { type: "media", device: "camera", enabled: true },
    ]),
  );
  fireEvent.click(button(/Mute mic/));
  fireEvent.click(within(card()).getByRole("button", { name: "Mute microphone" }));
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1]).toEqual({
    type: "media",
    device: "microphone",
    enabled: false,
  });
  await waitFor(() => expect(button("Standby")).toBeEnabled());
  fireEvent.click(button("Standby"));
  await waitFor(() => expect(sent().at(-1)).toEqual({ type: "cue", cue: "standby" }));
  // The live cue is armed first, then sent by a second press.
  const before = sent().length;
  await waitFor(() => expect(button("Cue live")).toBeEnabled());
  fireEvent.click(button("Cue live"));
  expect(sent()).toHaveLength(before);
  fireEvent.click(button(/Press again or Space: cue live/));
  await waitFor(() => expect(sent().at(-1)).toEqual({ type: "cue", cue: "live" }));
  // The wrap cue needs a hold; a short press sends nothing.
  await waitFor(() => expect(button(/Hold · cue wrap/)).toBeEnabled());
  const wrap = button(/Hold · cue wrap/);
  fireEvent.pointerDown(wrap);
  fireEvent.pointerUp(wrap);
  const afterLive = sent().length;
  fireEvent.pointerDown(wrap);
  await waitFor(() => expect(sent().at(-1)).toEqual({ type: "cue", cue: "wrap" }), { timeout: 2000 });
  expect(sent()).toHaveLength(afterLive + 1);
  const message = within(card()).getByLabelText("Message Ada");
  fireEvent.change(message, { target: { value: "You are on in 10" } });
  const send = button("Send message to Ada");
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() =>
    expect(sent().at(-1)).toEqual({
      type: "message",
      text: "You are on in 10",
    }),
  );
  await waitFor(() => expect(message).toHaveValue(""));
  serve({
    [`POST ${control}`]: () => new Response("Guest left", { status: 410 }),
  });
  await waitFor(() => expect(button("Standby")).toBeEnabled());
  fireEvent.click(button("Standby"));
  expect(await screen.findByText("Guest left")).toBeVisible();
});

it("disables controls a guest cannot take", async () => {
  participants = [
    participant({ connectionState: "offline", tracks: [], commands: [] }),
  ];
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("Dropped")).toBeVisible();
  expect(button(/Mute camera/)).toBeDisabled();
  expect(button(/Mute mic/)).toBeDisabled();
  expect(button("Cue live")).toBeDisabled();
  expect(button(/Hold · cue wrap/)).toBeDisabled();
  expect(button(/Hold · talk/)).toBeDisabled();
  expect(button(/Remove session/)).toBeDisabled();
  expect(within(card()).queryByText(/Latest/)).not.toBeInTheDocument();
});

// Review of #860: an offline guest's invitation has no live lease whether the call dropped or never started, so the
// invitation's status cannot tell them apart; the call's own reports can.
it("says Dropped for a guest whose call reported from the room, and Invited, not joined only for one who never did", async () => {
  invitations = [invitation({ status: "available" })];
  participants = [participant({ connectionState: "offline", tracks: [], commands: [], everJoined: true })];
  serve();
  const view = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("Dropped")).toBeVisible();
  view.unmount();

  participants = [participant({ connectionState: "offline", tracks: [], commands: [], everJoined: false })];
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("Invited, not joined")).toBeVisible();
});

it("shows a reconnecting guest muted in returns, with a muted microphone", async () => {
  participants = [
    participant({
      connectionState: "reconnecting",
      sourceMuted: true,
      tracks: [
        { sid: "m1", source: "microphone", muted: true },
        { sid: "c1", source: "camera", muted: false },
      ],
    }),
  ];
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("Connecting")).toBeVisible();
  expect(routing(/Muted in returns/)).toBeVisible();
  expect(button(/Request mic/)).toBeVisible();
  expect(button(/Mute camera/)).toBeVisible();
});

it("leaves every control read-only without the operate permission", async () => {
  permissions.operate = false;
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  for (const control of within(card()).getAllByRole("combobox"))
    expect(control).toBeDisabled();
  expect(button(/Replace link/)).toBeDisabled();
  expect(button(/Revoke/)).toBeDisabled();
});

it("replaces and revokes a link, and removes a guest session", async () => {
  const calls = serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.click(button(/Replace link/));
  expect(
    await screen.findByText(
      "Replacement link for slot 1 is ready. Copy it now.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(`${window.location.origin}/guest/secret-1b`),
  ).toBeVisible();
  await waitFor(() => expect(button(/Remove session/)).toBeEnabled());
  fireEvent.click(button(/Remove session/));
  fireEvent.click(within(card()).getByRole("button", { name: "Remove from call" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.init?.method === "DELETE" &&
          decodeURIComponent(call.url).endsWith("/participants/guest-ada"),
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(button(/Revoke/)).toBeEnabled());
  fireEvent.click(button(/Revoke/));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.init?.method === "DELETE" &&
          call.url.endsWith("/webrtc/invitations/inv-1"),
      ),
    ).toBe(true),
  );
  serve({
    "DELETE /webrtc/invitations/inv-1": () =>
      new Response("Already revoked", { status: 409 }),
    "DELETE /webrtc/rooms/main show/participants/guest-ada": () =>
      new Response("Not in room", { status: 404 }),
  });
  fireEvent.click(button(/Revoke/));
  expect(await screen.findByText("Already revoked")).toBeVisible();
  await waitFor(() => expect(button(/Remove session/)).toBeEnabled());
  fireEvent.click(button(/Remove session/));
  fireEvent.click(within(card()).getByRole("button", { name: "Remove from call" }));
  expect(await screen.findByText("Not in room")).toBeVisible();
});

it("talks privately only while held, and releases the microphone when the page closes", async () => {
  const calls = serve();
  const view = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const talk = button(/Hold · talk/);
  fireEvent.pointerDown(talk);
  await waitFor(() => expect(lk.state.rooms[0]?.published).toEqual(["talkback:inv-1"]));
  // Only Ada may receive this talkback, through the program's return router that builds her mix, set before the
  // track is published.
  expect(lk.state.rooms[0].allowed).toEqual([{ all: false, identities: ["guest-ada", "return-router-main show"], beforePublish: true }]);
  expect(bodyOf(calls, "/webrtc/operator-token")).toEqual({ programId: "main show" });
  expect(lk.state.rooms[0].connectedTo).toEqual(["wss://livekit.example", "fictional-operator-token"]);
  expect(button(/Talking… release to stop/)).toHaveAttribute("aria-pressed", "true");
  fireEvent.pointerUp(button(/Talking… release to stop/));
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(lk.state.rooms[0].disconnected).toBe(true);
  expect(button(/Hold · talk/)).toHaveAttribute("aria-pressed", "false");

  // Holding T while the strip has focus talks too; releasing T stops.
  card().focus();
  fireEvent.keyDown(card(), { key: "t" });
  await waitFor(() => expect(lk.state.rooms[1]?.published).toEqual(["talkback:inv-1"]));
  fireEvent.keyUp(card(), { key: "t" });
  expect(lk.state.rooms[1].disconnected).toBe(true);

  fireEvent.pointerDown(button(/Hold · talk/));
  await waitFor(() => expect(lk.state.rooms[2]?.published).toEqual(["talkback:inv-1"]));
  view.unmount();
  expect(lk.state.tracks[2].stopped).toBe(true);
  expect(lk.state.rooms[2].disconnected).toBe(true);
});

it("closes the microphone when talk is released before the connection is up", async () => {
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const talk = button(/Hold · talk/);
  fireEvent.pointerDown(talk);
  fireEvent.pointerUp(talk);
  await waitFor(() => expect(lk.state.rooms[0]?.disconnected).toBe(true));
  expect(lk.state.rooms[0].published).toEqual([]);
  expect(lk.state.tracks[0].stopped).toBe(true);
});

it("asks for a second confirmation before talking to a guest cued live", async () => {
  participants = [
    participant({
      commands: [{ id: "c9", type: "cue", status: "acknowledged", payload: { cue: "live" }, createdAt: "2026-11-22T12:00:00Z" }],
    }),
  ];
  serve({ "GET /program/main show/state": () => Response.json({ type: "tv" }) });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("Live · cued")).toBeVisible();
  expect(screen.getByText("1 guest cued live")).toBeVisible();
  expect(await within(card()).findByText(/on the output only through a scene/)).toBeVisible();
  expect(button(/Hold · talk/)).toBeDisabled();
  expect(within(card()).getByText("Allow private talk while live (never on air)").closest("label")).toHaveAttribute("title", "Talkback reaches only this guest. It never goes to air.");
  fireEvent.click(within(card()).getByRole("checkbox", { name: "Allow private talk while live (never on air)" }));
  expect(button(/Hold · talk/)).toBeEnabled();
  fireEvent.pointerDown(button(/Hold · talk/));
  await waitFor(() => expect(lk.state.rooms[0]?.published).toEqual(["talkback:inv-1"]));
  fireEvent.pointerUp(button(/Talking/));
  expect(lk.state.rooms[0].disconnected).toBe(true);
});

// alcantara#875: on a radio show a cued guest is on the air, and the strip must not say otherwise.
it.each([
  ["radio", "Cued live: they go out on the radio until you wrap or stand them by."],
  ["both", "Cued live: they go out on the radio. On television they appear only through a scene that carries them."],
  [undefined, "Sent the live cue."],
])("says where a guest cued live goes out on a %s show", async (type, note) => {
  participants = [
    participant({
      commands: [{ id: "c9", type: "cue", status: "acknowledged", payload: { cue: "live" }, createdAt: "2026-11-22T12:00:00Z" }],
    }),
  ];
  serve({
    "GET /program/main show/state": () => (type ? Response.json({ type }) : new Response(null, { status: 500 })),
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(await within(card()).findByText(note, { exact: true })).toBeVisible();
  if (type !== "both") expect(within(card()).queryByText(/only through a scene/)).toBeNull();
});

it("explains talkback that could not be authorized", async () => {
  serve({
    "POST /webrtc/operator-token": () =>
      new Response("Not allowed", { status: 403 }),
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  expect(await screen.findByText("Not allowed")).toBeVisible();
  expect(button(/Hold · talk/)).toHaveAttribute("aria-pressed", "false");
});

it("refreshes on demand", async () => {
  const calls = serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  const before = calls.filter((call) =>
    call.url.endsWith("/webrtc/config"),
  ).length;
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.url.endsWith("/webrtc/config")).length,
    ).toBe(before + 1),
  );
});

it("reports a refused operator token by its raw text when the body is JSON without a message", async () => {
  serve({
    "POST /webrtc/operator-token": () => new Response(JSON.stringify({ error: "busy" }), { status: 403 }),
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  expect(await screen.findByText('{"error":"busy"}')).toBeVisible();
  expect(button(/Hold · talk/)).toHaveAttribute("aria-pressed", "false");
});

it("ignores a second talk press while the first is still being set up", async () => {
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  fireEvent.pointerDown(button(/Talking… release to stop/));
  await waitFor(() => expect(lk.state.rooms[0]?.published).toEqual(["talkback:inv-1"]));
  expect(lk.state.rooms).toHaveLength(1);
});

it("reports a talkback that fails with something other than an error as a plain failure", async () => {
  lk.state.failConnectWith = "room unreachable";
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  expect(await screen.findByText("Talkback failed.")).toBeVisible();
  expect(button(/Hold · talk/)).toHaveAttribute("aria-pressed", "false");
});

it("shows an invited slot whose guest has not joined yet", async () => {
  invitations = [invitation({ status: "available" })];
  participants = [];
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Ada · Invited")).toBeVisible();
  expect(screen.getByText("1/6 slots assigned")).toBeVisible();
});

it("shows a guest who was in the call and left as Left, with the link still usable", async () => {
  invitations = [invitation({ status: "active" })];
  participants = [];
  serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Ada · Left")).toBeVisible();
});

it("does not start a second guest's talkback while the first is being set up", async () => {
  invitations = [invitation(), invitation({ id: "inv-2", displayName: "Bo", slotNumber: 2 })];
  participants = [
    participant(),
    participant({ invitationId: "inv-2", identity: "guest-bo", name: "Bo", slotNumber: 2 }),
  ];
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  const bo = screen.getByRole("article", { name: /: Bo$/ });
  fireEvent.pointerDown(within(bo).getByRole("button", { name: /Hold · talk/ }));
  await waitFor(() => expect(lk.state.rooms[0]?.published).toEqual(["talkback:inv-1"]));
  expect(lk.state.rooms).toHaveLength(1);
  expect(lk.state.rooms[0].published).toEqual(["talkback:inv-1"]);
});

it("asks for the guest-call state again every three seconds", async () => {
  const calls = serve();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    render(<CallsRoute />);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});

it("refreshes the guest list every 3 seconds, and a failed background refresh stays quiet", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const calls = serve();
    render(<CallsRoute />);
    await vi.advanceTimersByTimeAsync(0);
    expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls.length).toBeGreaterThan(before);

    serve({ "GET /webrtc/config": () => new Response("down", { status: 500 }) });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.queryByText("Guest calls could not be refreshed.")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// A waiting guest must never sit unseen behind a desk that stopped updating: a hidden tab's timers run about once a
// minute, so the desk catches up when it is looked at, says when it last heard from the API, and says when it can't.
it("catches up when the tab is shown or focused, and says when it last updated", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const calls = serve();
    render(<CallsRoute />);
    await vi.advanceTimersByTimeAsync(0);
    expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
    expect(screen.getByText(/^Updated \d/)).toBeVisible();
    const participantsAsked = () => calls.filter((call) => call.url.includes("/participants")).length;
    const before = participantsAsked();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(participantsAsked()).toBe(before);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(participantsAsked()).toBe(before + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(participantsAsked()).toBe(before + 2);
  } finally {
    vi.useRealTimers();
  }
});

it("says the desk is not updating after two failed refreshes in a row, and clears it when one succeeds", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    serve();
    render(<CallsRoute />);
    await vi.advanceTimersByTimeAsync(0);
    expect(await screen.findByText("Ada", { selector: "h3" })).toBeVisible();
    serve({ "GET /webrtc/config": () => new Response("down", { status: 500 }) });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.queryByText(/The desk is not updating/)).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.getByRole("alert")).toHaveTextContent("The desk is not updating: the last 2 refreshes failed.");
    serve();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(screen.queryByText(/The desk is not updating/)).toBeNull());
  } finally {
    vi.useRealTimers();
  }
});

// gaulatti/alcantara#875: a screenshot a second after the second press still read "Cue · none sent": the line
// waited for the next read of the room.
it("changes the cue line from the command's own answer, before the room is read again", async () => {
  participants = [participant({ cueState: null, commands: [] })];
  let sent = false;
  serve({
    "POST /webrtc/rooms/main show/participants/guest-ada/control": () => {
      sent = true;
      return Response.json({ id: "c9", type: "cue", status: "delivered", payload: { cue: "standby" }, createdAt: "" });
    },
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(card()).toHaveTextContent("Cue · none sent");
  // Every later read of the room hangs.
  const answer = api.handler!;
  api.handler = (url, init) => (sent && url.endsWith("/participants") ? new Promise<Response>(() => {}) : answer(url, init));
  fireEvent.click(button("Standby"));
  await waitFor(() => expect(card()).toHaveTextContent("Cue · standby"));
  expect(within(card()).getByText("Latest cue:")).toBeVisible();
});

// gaulatti/alcantara#875: a broken call chain is said on the desk, before a guest has to say it.
it("says in one line that part of the call chain is down", async () => {
  serve({
    "GET /webrtc/health": () => Response.json({ returnRunner: "down", contribution: "ok", livekit: "ok", checkedAt: "" }),
  });
  render(<CallsRoute />);
  expect(await screen.findByTestId("call-health")).toHaveTextContent("Guests can't hear the studio right now.");
});

// Seen in production: one show's guest listed under another show's header, while the stored show arrived after the
// page had loaded. An operator could have admitted, cued or revoked a guest of the wrong show.
const other = () => {
  invitations = [invitation(), invitation({ id: "inv-x", programId: "other show", displayName: "Bea" })];
};

it("drops the previous show's late answer when the show changes", async () => {
  other();
  let release!: (response: Response) => void;
  serve();
  const answer = api.handler!;
  api.handler = (url, init) =>
    decodeURIComponent(url).endsWith("/webrtc/rooms/main show/participants")
      ? new Promise<Response>((resolve) => (release = resolve))
      : decodeURIComponent(url).endsWith("/webrtc/rooms/other show/participants")
        ? Promise.resolve(Response.json({ room, participants: [] }))
        : answer(url, init);
  const view = render(<CallsRoute />);
  await waitFor(() => expect(release).toBeDefined());
  shown.program = "other show";
  view.rerender(<CallsRoute />);
  await screen.findByText("Bea · Left");
  await act(async () => release(Response.json({ room, participants: [participant()] })));
  expect(screen.getByText("Bea · Left")).toBeVisible();
  expect(screen.queryByText("Ada", { selector: "h3" })).toBeNull();
  expect(screen.queryByText(/Ada/)).toBeNull();
});

it("starts empty on a switch, with nothing of the previous show to act on", async () => {
  other();
  serve();
  const view = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.change(within(card()).getByLabelText("Message Ada"), { target: { value: "for Ada" } });
  // The next show's reads never answer.
  api.handler = () => new Promise<Response>(() => {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  shown.program = "other show";
  view.rerender(<CallsRoute />);
  expect(screen.getByText(/slots for other show/)).toBeVisible();
  expect(screen.queryByRole("article")).toBeNull();
  expect(screen.queryByText(/Ada/)).toBeNull();
});

it("does not open the microphone for a talkback still connecting when the show changes", async () => {
  other();
  let release!: (response: Response) => void;
  serve();
  const answer = api.handler!;
  api.handler = (url, init) => (url.endsWith("/webrtc/operator-token") ? new Promise<Response>((resolve) => (release = resolve)) : answer(url, init));
  const view = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.pointerDown(button(/Hold · talk/));
  await waitFor(() => expect(release).toBeDefined());
  shown.program = "other show";
  view.rerender(<CallsRoute />);
  await act(async () => release(Response.json({ serverUrl: "wss://livekit.example", token: "t" })));
  await waitFor(() => expect(lk.state.tracks.every((track) => track.stopped)).toBe(true));
  expect(lk.state.rooms.flatMap((made) => made.published)).toEqual([]);
  expect(lk.state.rooms.every((made) => made.disconnected)).toBe(true);
});

const typeGuest = async () => {
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.change(screen.getByPlaceholderText("Fictional guest"), {
    target: { value: "Grace" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create private link/ }));
};
const stubClipboard = (write: () => Promise<void>) => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(), write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly items: Record<string, unknown>) {}
    },
  );
};

it("keeps the new link on screen when the clipboard write is rejected", async () => {
  serve();
  stubClipboard(() => Promise.reject(new Error("NotAllowedError")));
  await typeGuest();
  expect(
    await screen.findByText(
      "Guest slot 2 is ready. Copy the private link below and send it to the guest.",
    ),
  ).toBeVisible();
});

it("reports only the failed create when the link being copied never arrives", async () => {
  serve({
    "POST /webrtc/invitations": () =>
      Response.json({ message: "No free slot" }, { status: 409 }),
  });
  const write = vi.fn(() => Promise.resolve());
  stubClipboard(write);
  await typeGuest();
  expect(await screen.findByText("No free slot")).toBeVisible();
  expect(write).toHaveBeenCalledTimes(1);
});

it("lists a guest who is waiting to be let in, off their strip, and admits or declines them", async () => {
  participants = [participant({ screening: true })];
  const calls = serve();
  render(<CallsRoute />);
  expect(await screen.findByText("Ada · waiting to be let in")).toBeVisible();
  expect(screen.getByText("Waiting · 1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Admit Ada" }));
  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/webrtc/invitations/inv-1/admit"))).toBe(true),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Decline Ada" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Decline Ada" }));
  expect(
    await screen.findByText("The guest was declined: their link no longer works and the slot is free."),
  ).toBeVisible();
});

it("says why a guest could not be admitted", async () => {
  participants = [participant({ screening: true })];
  serve({
    "POST /webrtc/invitations/inv-1/admit": () =>
      Response.json({ message: "The guest has left" }, { status: 409 }),
  });
  render(<CallsRoute />);
  fireEvent.click(await screen.findByRole("button", { name: "Admit Ada" }));
  expect(await screen.findByText("The guest has left")).toBeVisible();
});
