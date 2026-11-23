import {
  cleanup,
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
    }[],
    tracks: [] as { stopped: boolean }[],
  };
  class Room {
    connectedTo: string[] = [];
    published: string[] = [];
    disconnected = false;
    localParticipant = {
      publishTrack: async (_track: unknown, options: { name: string }) => {
        this.published.push(options.name);
      },
    };
    constructor() {
      state.rooms.push(this);
    }
    async connect(url: string, token: string) {
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
const permissions = vi.hoisted(() => ({ operate: true }));

vi.mock("livekit-client", () => ({
  Room: lk.Room,
  createLocalAudioTrack: lk.createLocalAudioTrack,
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ hasPermission: () => permissions.operate }),
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main show"],
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
      return Response.json({ participants });
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
const card = () =>
  screen
    .getByText("Ada", { selector: "h3" })
    .closest("div.p-5, [class*='p-5']") as HTMLElement;
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
  permissions.operate = true;
  config = { enabled: true };
  invitations = [
    invitation(),
    invitation({ id: "inv-x", programId: "other show" }),
  ];
  participants = [participant()];
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
  expect(await screen.findByText("LiveKit is not configured")).toBeVisible();
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
  "explains a call list that cannot be loaded (%s)",
  async (route, answer, message) => {
    serve({ [route]: answer });
    render(<CallsRoute />);
    expect(await screen.findByText(message)).toBeVisible();
  },
);

it("explains a failure that is not an error object", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
  render(<CallsRoute />);
  expect(await screen.findByText("Unable to load calls.")).toBeVisible();
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
  expect(within(card()).getByText("connected")).toBeVisible();
  expect(within(card()).getByText("Latest cue:")).toBeVisible();
  expect(button(/Request camera/)).toBeEnabled();
  expect(button(/Mute mic/)).toBeEnabled();
  expect(routing(/Routed to returns/)).toBeEnabled();
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
  serve({ "GET /webrtc/config": () => new Response("down", { status: 500 }) });
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await waitFor(() => expect(status()).toHaveTextContent("down"));
});

it("creates a private link for a named guest and copies it", async () => {
  const calls = serve();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
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
    await screen.findByText("Guest slot 2 is ready. Copy the private URL now."),
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
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1]).toEqual({
    type: "media",
    device: "microphone",
    enabled: false,
  });
  for (const cue of ["standby", "live", "wrap"]) {
    await waitFor(() => expect(button(cue)).toBeEnabled());
    fireEvent.click(button(cue));
    await waitFor(() => expect(sent().at(-1)).toEqual({ type: "cue", cue }));
  }
  const message = within(card()).getByLabelText("Message Ada");
  fireEvent.change(message, { target: { value: "You are on in 10" } });
  const send = message.closest("div.mt-3")!.querySelector("button")!;
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
  await waitFor(() => expect(button("wrap")).toBeEnabled());
  fireEvent.click(button("wrap"));
  expect(await screen.findByText("Guest left")).toBeVisible();
});

it("disables controls a guest cannot take", async () => {
  participants = [
    participant({ connectionState: "offline", tracks: [], commands: [] }),
  ];
  serve();
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  expect(within(card()).getByText("offline")).toBeVisible();
  expect(button(/Mute camera/)).toBeDisabled();
  expect(button(/Mute mic/)).toBeDisabled();
  expect(button("live")).toBeDisabled();
  expect(button(/Talkback/)).toBeDisabled();
  expect(button(/Remove session/)).toBeDisabled();
  expect(within(card()).queryByText(/Latest/)).not.toBeInTheDocument();
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
  expect(within(card()).getByText("reconnecting")).toBeVisible();
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
  expect(await screen.findByText("Not in room")).toBeVisible();
});

it("starts and stops private talkback, and releases it when the page closes", async () => {
  const calls = serve();
  const view = render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.click(button(/Talkback/));
  expect(
    await screen.findByText(
      "Private talkback is live to Ada. Select it again to stop.",
    ),
  ).toBeVisible();
  expect(bodyOf(calls, "/webrtc/operator-token")).toEqual({
    programId: "main show",
  });
  expect(lk.state.rooms[0].connectedTo).toEqual([
    "wss://livekit.example",
    "fictional-operator-token",
  ]);
  expect(lk.state.rooms[0].published).toEqual(["talkback:inv-1"]);
  await waitFor(() => expect(button(/Talkback/)).toBeEnabled());
  fireEvent.click(button(/Talkback/));
  expect(await screen.findByText("Talkback stopped.")).toBeVisible();
  expect(lk.state.tracks[0].stopped).toBe(true);
  expect(lk.state.rooms[0].disconnected).toBe(true);

  await waitFor(() => expect(button(/Talkback/)).toBeEnabled());
  fireEvent.click(button(/Talkback/));
  await screen.findByText(
    "Private talkback is live to Ada. Select it again to stop.",
  );
  view.unmount();
  expect(lk.state.tracks[1].stopped).toBe(true);
  expect(lk.state.rooms[1].disconnected).toBe(true);
});

it("explains talkback that could not be authorized", async () => {
  serve({
    "POST /webrtc/operator-token": () =>
      new Response("Not allowed", { status: 403 }),
  });
  render(<CallsRoute />);
  await screen.findByText("Ada", { selector: "h3" });
  fireEvent.click(button(/Talkback/));
  expect(await screen.findByText("Not allowed")).toBeVisible();
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
