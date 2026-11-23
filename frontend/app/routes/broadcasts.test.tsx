import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AxiosError } from "axios";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Broadcasts, { meta } from "./broadcasts";

// gaulatti/alcantara#187, group G4: the television broadcast destinations
// page, through the API it calls. The filler panel belongs to
// gaulatti/alcantara#184, so it is a stand-in here.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("../services/api", async (original) => ({
  ...(await original<typeof import("../services/api")>()),
  api,
}));
const features = vi.hoisted(() => ({
  loading: false,
  granted: new Set<string>(),
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({
    loading: features.loading,
    hasPermission: (permission: string) => features.granted.has(permission),
  }),
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["news tv"],
}));
vi.mock("../components/ProgramFillerPanel", () => ({
  ProgramFillerPanel: ({
    programId,
    canManage,
  }: {
    programId: string;
    canManage: boolean;
  }) => (
    <p>
      Fillers for {programId}
      {canManage ? " (manage)" : ""}
    </p>
  ),
}));

type State = {
  programId: string;
  available: boolean;
  destinations: {
    id: string;
    displayName: string;
    position: number;
    retired: boolean;
  }[];
  downstream: Record<string, unknown>;
};

let state: State;
let catalog: Record<string, unknown>[];

const downstream = (overrides: Record<string, unknown> = {}) => ({
  requestedState: "stopped",
  actualState: "stopped",
  transition: null,
  readiness: true,
  destinations: [],
  activeDestinations: null,
  pendingDestinations: null,
  ...overrides,
});

const refusal = (status: number, data: unknown = {}) =>
  new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    data,
    statusText: "",
    headers: {},
    config: {} as never,
  });

beforeEach(() => {
  features.loading = false;
  features.granted = new Set([
    "broadcast.view",
    "broadcast.operate",
    "broadcast.manage",
  ]);
  state = {
    programId: "news tv",
    available: true,
    destinations: [
      {
        id: "primary",
        displayName: "Primary platform",
        position: 0,
        retired: false,
      },
      {
        id: "backup",
        displayName: "Backup platform",
        position: 1,
        retired: false,
      },
      { id: "old", displayName: "Old platform", position: 2, retired: true },
    ],
    downstream: downstream(),
  };
  catalog = [
    {
      id: "primary",
      displayName: "Primary platform",
      position: 0,
      retired: false,
      secretId: "broadcast/primary",
      secretVersionId: "v-1",
      service: null,
      ingestUrl: null,
      keyLast4: null,
      keySetAt: null,
      retiredAt: null,
    },
    {
      id: "backup",
      displayName: "Backup platform",
      position: 1,
      retired: false,
      secretId: "broadcast/backup",
      secretVersionId: "v-2",
      service: "youtube",
      ingestUrl: "rtmps://a.rtmps.youtube.com:443/live2",
      keyLast4: "7d6c",
      keySetAt: "2026-11-23T12:00:00.000Z",
      retiredAt: null,
    },
    {
      id: "old",
      displayName: "Old platform",
      position: 2,
      retired: true,
      secretId: "broadcast/old",
      secretVersionId: "v-3",
      service: null,
      ingestUrl: null,
      keyLast4: null,
      keySetAt: null,
      retiredAt: "2026-01-01T00:00:00Z",
    },
  ];
  api.get.mockImplementation(async (path: string) => {
    if (path === "/broadcast/programs/news%20tv")
      return { data: structuredClone(state) };
    if (path === "/broadcast/destinations/catalog")
      return { data: structuredClone(catalog) };
    throw new Error(`unexpected GET ${path}`);
  });
  api.post.mockResolvedValue({
    data: {
      commandId: "c",
      action: "start",
      status: "ok",
      selectionVersion: null,
    },
  });
  api.put.mockResolvedValue({ data: {} });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
});

const page = async () => {
  render(<Broadcasts />);
  return screen.findByText("Executor state");
};
const checkbox = (name: string) =>
  screen
    .getAllByText(name)
    .map((text) => text.closest("label"))
    .find(Boolean)!
    .querySelector("input") as HTMLInputElement;
const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeInTheDocument();

it("names the page for the browser", () => {
  expect(meta({} as never)).toEqual([
    { title: "Broadcast destinations - Alcantara" },
    {
      name: "description",
      content: "Select and operate versioned public broadcast destinations.",
    },
  ]);
});

it("waits for permissions, and refuses an operator without broadcast.view", async () => {
  features.loading = true;
  const { rerender } = render(<Broadcasts />);
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByText("Executor state")).toBeNull();
  features.loading = false;
  features.granted = new Set();
  rerender(<Broadcasts />);
  expect(
    await screen.findByText("You do not have broadcast.view permission."),
  ).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
});

it("shows the executor and the relays to a viewer who cannot change them", async () => {
  features.granted = new Set(["broadcast.view"]);
  state.available = false;
  state.downstream = downstream({
    requestedState: "running",
    actualState: "starting",
    transition: "starting",
    readiness: false,
    destinations: [
      {
        id: "primary",
        displayName: "Primary platform",
        mode: "relay",
        supervisorHealthy: true,
        publisherProcessHealthy: false,
      },
      {
        id: "backup",
        displayName: "Backup platform",
        mode: "standby",
        supervisorHealthy: false,
        publisherProcessHealthy: true,
      },
    ],
    activeDestinations: { version: "v1", destinationIds: ["primary"] },
  });
  await page();
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Requested running")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(screen.getByText("Actual starting")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(screen.getByText("starting")).toBeInTheDocument();
  expect(screen.getByText("Alana unavailable")).toBeInTheDocument();
  expect(screen.getByText("Pipeline not ready")).toBeInTheDocument();
  expect(
    screen.getByText("relay · supervisor healthy · publisher unhealthy"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("standby · supervisor unhealthy · publisher healthy"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Old platform")).toBeNull();
  expect(checkbox("Primary platform").checked).toBe(true);
  expect(checkbox("Primary platform")).toBeDisabled();
  expect(
    screen.getByText(/broadcast.operate is required to change it/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Destination catalog")).toBeNull();
  expect(screen.queryByRole("button", { name: /Add destination/ })).toBeNull();
  expect(screen.getByText("Fillers for news tv")).toBeInTheDocument();
});

it("reads an unknown executor and an empty selection without failing", async () => {
  features.granted = new Set(["broadcast.view", "broadcast.operate"]);
  state.destinations = [];
  state.downstream = downstream({
    requestedState: undefined,
    actualState: undefined,
  });
  await page();
  expect(screen.getByText("Requested unknown")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(screen.getByText("Actual unknown")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(
    screen.getByText("No configured destinations are available."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Confirm Start/ })).toBeDisabled();
});

it("starts from the pending selection when there is one", async () => {
  state.downstream = downstream({
    activeDestinations: { version: "v1", destinationIds: ["primary"] },
    pendingDestinations: { version: "v2", destinationIds: ["backup"] },
  });
  await page();
  expect(checkbox("Backup platform").checked).toBe(true);
  expect(checkbox("Primary platform").checked).toBe(false);
});

it("validates a stopped selection, then starts with that validated version", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000001",
  );
  await page();
  expect(screen.getByText("Requested stopped")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(screen.getByText("Actual stopped")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(screen.getByText("Alana reachable")).toBeInTheDocument();
  expect(screen.getByText("Pipeline ready")).toBeInTheDocument();
  const reload = screen.getByRole("button", { name: /Reload while stopped/ });
  expect(reload).toBeDisabled();
  fireEvent.click(checkbox("Primary platform"));
  fireEvent.click(checkbox("Backup platform"));

  let validate: (value: unknown) => void = () => {};
  api.post.mockImplementationOnce(
    () => new Promise((resolve) => (validate = resolve)),
  );
  fireEvent.click(reload);
  expect(await screen.findByText("Validating…")).toBeInTheDocument();
  await act(async () =>
    validate({
      data: {
        commandId: "c",
        action: "reload",
        status: "ok",
        selectionVersion: "sel-7",
      },
    }),
  );
  expect(api.post).toHaveBeenLastCalledWith(
    "/broadcast/programs/news%20tv/reload",
    {
      commandId: "00000000-0000-4000-8000-000000000001",
      confirmed: true,
      destinationIds: ["primary", "backup"],
    },
  );
  await toast("Destination selection validated for the next Start.");
  expect(screen.getByText("Validated sel-7")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Confirm Start/ }));
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm television Start",
  });
  expect(dialog).toHaveTextContent(
    "Start news tv's television leg with 2 immutable destinations? Running will appear only after Alana and Croccante acknowledge this exact selection.",
  );
  let start: (value: unknown) => void = () => {};
  api.post.mockImplementationOnce(
    () => new Promise((resolve) => (start = resolve)),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start broadcast" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Sending…" }),
  ).toBeDisabled();
  await act(async () =>
    start({
      data: {
        commandId: "c",
        action: "start",
        status: "ok",
        selectionVersion: null,
      },
    }),
  );
  expect(api.post).toHaveBeenLastCalledWith(
    "/broadcast/programs/news%20tv/start",
    {
      commandId: "00000000-0000-4000-8000-000000000001",
      confirmed: true,
      destinationIds: ["primary", "backup"],
      selectionVersion: "sel-7",
    },
  );
  await toast(
    "Television broadcast is Running with the acknowledged selection.",
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("forgets a validated version when the selection changes", async () => {
  api.post.mockResolvedValue({
    data: {
      commandId: "c",
      action: "reload",
      status: "ok",
      selectionVersion: "sel-1",
    },
  });
  await page();
  fireEvent.click(checkbox("Primary platform"));
  fireEvent.click(screen.getByRole("button", { name: /Reload while stopped/ }));
  expect(await screen.findByText("Validated sel-1")).toBeInTheDocument();
  fireEvent.click(checkbox("Backup platform"));
  expect(screen.queryByText(/Validated/)).toBeNull();
  fireEvent.click(checkbox("Backup platform"));
  fireEvent.click(screen.getByRole("button", { name: /Confirm Start/ }));
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm television Start",
  });
  expect(dialog).toHaveTextContent("with 1 immutable destination?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("stops a running broadcast, and reports a refused command", async () => {
  state.downstream = downstream({
    requestedState: "running",
    actualState: "running",
    activeDestinations: { version: "v1", destinationIds: ["primary"] },
  });
  await page();
  expect(screen.getByText("Actual running")).toBeInTheDocument(); // StatePill tone, not colour alone (#349)
  expect(checkbox("Primary platform")).toBeDisabled();
  expect(screen.getByRole("button", { name: /Confirm Start/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Confirm Stop/ }));
  let dialog = await screen.findByRole("dialog", {
    name: "Confirm television Stop",
  });
  expect(dialog).toHaveTextContent(
    "Stop news tv's television leg? Destination changes remain unavailable until Alana acknowledges Stopped.",
  );
  api.post.mockRejectedValueOnce(
    refusal(409, { error: "Alana is still starting." }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Stop broadcast" }),
  );
  await toast("Alana is still starting.");
  expect(api.post).toHaveBeenLastCalledWith(
    "/broadcast/programs/news%20tv/stop",
    {
      commandId: expect.any(String),
      confirmed: true,
    },
  );

  fireEvent.click(screen.getByRole("button", { name: /Confirm Stop/ }));
  dialog = await screen.findByRole("dialog", {
    name: "Confirm television Stop",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Stop broadcast" }),
  );
  await toast("Television broadcast is Stopped.");
});

// A failed first load raises its alert before the page's AlertContainer
// mounts, so it is not shown (reported on gaulatti/alcantara#187); only the
// polling is asserted here.
it("refreshes every five seconds while the tab is visible, after a failed first load", async () => {
  const intervals: (() => void)[] = [];
  const setInterval = vi.spyOn(window, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    if (delay === 5000) intervals.push(callback);
    return 1;
  }) as never);
  api.get.mockRejectedValueOnce(refusal(500));
  render(<Broadcasts />);
  // A failed first load shows the error state with a retry (gaulatti/alcantara#349).
  await screen.findByText("Broadcasts could not be loaded");
  expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
  const before = api.get.mock.calls.length;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  await act(async () => intervals.at(-1)!());
  expect(api.get.mock.calls.length).toBe(before);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  api.get.mockRejectedValueOnce(new Error("offline"));
  await act(async () => intervals.at(-1)!());
  await act(async () => intervals.at(-1)!());
  expect(api.get.mock.calls.length).toBeGreaterThan(before);
});

it("adds, renames, replaces keys, reorders, retires and restores catalog destinations", async () => {
  await page();
  const catalogCard = screen
    .getByText("Destination catalog")
    .closest("div")!.parentElement!;
  expect(
    within(catalogCard).getAllByText("Secret reference (added by hand)").length,
  ).toBe(2);
  expect(within(catalogCard).getByText("YouTube")).toBeInTheDocument();
  expect(within(catalogCard).getByText(/Key ••••7d6c/)).toBeInTheDocument();
  expect(within(catalogCard).getByText("(retired)")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Move Primary platform up" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Move Old platform down" }),
  ).toBeDisabled();
  expect(screen.getByText("Fillers for news tv (manage)")).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Move Primary platform down" }),
  );
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/broadcast/destinations/order", {
      destinationIds: ["backup", "primary", "old"],
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Move Backup platform up" }),
  );
  await waitFor(() =>
    expect(api.put).toHaveBeenLastCalledWith("/broadcast/destinations/order", {
      destinationIds: ["backup", "primary", "old"],
    }),
  );
  api.put.mockRejectedValueOnce(refusal(403));
  fireEvent.click(
    await screen.findByRole("button", { name: "Move Backup platform down" }),
  );
  await toast("Access denied");

  // Add: a service, a name and a key; the secret name and version are never asked for.
  fireEvent.click(screen.getByRole("button", { name: /Add destination/ }));
  let dialog = await screen.findByRole("dialog", { name: "Add destination" });
  expect(within(dialog).queryByText(/Secrets Manager reference/)).toBeNull();
  const addButton = () => within(dialog).getByRole("button", { name: "Add destination" });
  expect(addButton()).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
    target: { value: "backup platform" },
  });
  expect(await within(dialog).findByText("A destination with this name already exists.")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
    target: { value: "Third platform" },
  });
  const key = () => within(dialog).getByLabelText("Stream key") as HTMLInputElement;
  expect(key().type).toBe("password");
  fireEvent.change(key(), { target: { value: "has space" } });
  expect(await within(dialog).findByText("A stream key has no spaces.")).toBeInTheDocument();
  fireEvent.change(key(), { target: { value: "live_Third-9f8e7d6c" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show key" }));
  expect(key().type).toBe("text");
  // A custom service asks for an address and checks it inline.
  fireEvent.click(within(dialog).getByRole("button", { name: "Custom RTMP(S)" }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Ingest URL/ }), {
    target: { value: "http://example.test/live" },
  });
  expect(await within(dialog).findByText(/Use an rtmp:\/\/ or rtmps:\/\/ address/)).toBeInTheDocument();
  expect(addButton()).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Ingest URL/ }), {
    target: { value: "rtmps://ingest.example.test/live" },
  });
  expect(addButton()).toBeEnabled();
  let save: (value: unknown) => void = () => {};
  api.post.mockImplementationOnce(
    () => new Promise((resolve) => (save = resolve)),
  );
  fireEvent.click(addButton());
  expect(
    await within(dialog).findByRole("button", { name: "Saving…" }),
  ).toBeDisabled();
  await act(async () => save({ data: {} }));
  expect(api.post).toHaveBeenLastCalledWith("/broadcast/destinations", {
    service: "custom",
    name: "Third platform",
    ingestUrl: "rtmps://ingest.example.test/live",
    streamKey: "live_Third-9f8e7d6c",
  });
  await toast("Destination added.");

  // YouTube needs no address.
  fireEvent.click(screen.getByRole("button", { name: /Add destination/ }));
  dialog = await screen.findByRole("dialog", { name: "Add destination" });
  expect(within(dialog).getByText(/rtmps:\/\/a\.rtmps\.youtube\.com:443\/live2/)).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox", { name: /^Ingest URL/ })).toBeNull();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
    target: { value: "Fourth" },
  });
  fireEvent.change(key(), { target: { value: "live_Fourth-1234" } });
  api.post.mockRejectedValueOnce(refusal(409, { error: "A destination with this name already exists." }));
  fireEvent.click(addButton());
  await toast("A destination with this name already exists.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Rename: the name only.
  fireEvent.click(screen.getAllByRole("button", { name: /Rename/ })[0]);
  dialog = await screen.findByRole("dialog", { name: "Rename destination" });
  expect(within(dialog).getByRole("textbox", { name: /^Name/ })).toHaveValue("Primary platform");
  expect(within(dialog).queryByLabelText("Stream key")).toBeNull();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
    target: { value: "Main platform" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await toast("Destination renamed.");
  expect(api.put).toHaveBeenLastCalledWith("/broadcast/destinations/primary", {
    displayName: "Main platform",
  });

  // Replace key on a YouTube destination: only the key is sent; the old one is never shown.
  fireEvent.click(screen.getByRole("button", { name: /Replace key/ }));
  dialog = await screen.findByRole("dialog", { name: "Replace key" });
  expect(within(dialog).getByText(/ends in ••••7d6c/)).toBeInTheDocument();
  fireEvent.change(key(), { target: { value: "live_Replaced-0000aaaa" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
  await toast("Key replaced. It applies from the next start.");
  expect(api.put).toHaveBeenLastCalledWith("/broadcast/destinations/backup/key", {
    streamKey: "live_Replaced-0000aaaa",
  });

  // A destination added by hand names its service when it gets a key.
  fireEvent.click(screen.getAllByRole("button", { name: /Set key/ })[0]);
  dialog = await screen.findByRole("dialog", { name: "Set key" });
  fireEvent.change(key(), { target: { value: "live_Hand-1234abcd" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
  await toast("Key replaced. It applies from the next start.");
  expect(api.put).toHaveBeenLastCalledWith("/broadcast/destinations/primary/key", {
    streamKey: "live_Hand-1234abcd",
    service: "youtube",
  });

  // Retire is confirmed by name before it is sent; a Cancel sends nothing.
  fireEvent.click(screen.getAllByRole("button", { name: /^Retire$/ })[0]);
  const retireDialog = await screen.findByRole("dialog", { name: "Confirm retire" });
  expect(api.post).not.toHaveBeenCalledWith("/broadcast/destinations/primary/retire");
  fireEvent.click(within(retireDialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm retire" })).toBeNull());
  expect(api.post).not.toHaveBeenCalledWith("/broadcast/destinations/primary/retire");
  fireEvent.click(screen.getAllByRole("button", { name: /^Retire$/ })[0]);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm retire" })).getByRole("button", { name: "Retire destination" }));
  await toast("Destination retired. Active sessions are unchanged.");
  expect(api.post).toHaveBeenLastCalledWith(
    "/broadcast/destinations/primary/retire",
  );
  fireEvent.click(await screen.findByRole("button", { name: /Restore/ }));
  await toast("Destination restored.");
  expect(api.post).toHaveBeenLastCalledWith(
    "/broadcast/destinations/old/restore",
  );
  api.post.mockRejectedValueOnce(refusal(404));
  fireEvent.click(screen.getAllByRole("button", { name: /^Retire$/ })[0]);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm retire" })).getByRole("button", { name: "Retire destination" }));
  await toast("Resource not found");
});

it("retries a failed first load from the error state, and recovers", async () => {
  api.get.mockRejectedValueOnce(refusal(500));
  render(<Broadcasts />);
  expect(await screen.findByText("Broadcasts could not be loaded")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Executor state")).toBeInTheDocument();
  expect(screen.queryByText("Broadcasts could not be loaded")).toBeNull();
});

it("shows a skeleton while the first load is pending, not an empty page", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async (...args: unknown[]) => {
    await gate;
    return original!(...(args as Parameters<typeof api.get>));
  });
  render(<Broadcasts />);
  expect(screen.getByLabelText("Loading broadcasts")).toHaveAttribute("aria-busy", "true");
  release();
  expect(await screen.findByText("Executor state")).toBeInTheDocument();
});

it("says so when the catalog is empty, with the next step", async () => {
  const saved = catalog;
  catalog = [];
  try {
    render(<Broadcasts />);
    await screen.findByText("Executor state");
    expect(await screen.findByText("No destinations yet")).toBeInTheDocument();
    expect(screen.getByText("Add a destination with its stream key. A Start needs at least one current destination.")).toBeInTheDocument();
  } finally {
    catalog = saved;
  }
});
