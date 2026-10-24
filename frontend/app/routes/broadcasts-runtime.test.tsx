import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Provider } from "react-redux";
import { legacy_createStore } from "redux";
import { MemoryRouter } from "react-router";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { ConsolePreferencesProvider } from "../contexts/ConsolePreferencesContext";
import { FeaturesProvider } from "../hooks/useFeatures";
import { reducers } from "../state/reducers";
import { api } from "../services/api";
import Broadcasts from "./broadcasts";

// These are fabricated public reference identifiers, never secret values.
// Only identity and HTTP/browser boundaries are fixtures. Permissions,
// destination selection, confirmation, services, scoring of state and UI are real.
vi.mock("../services/session", () => ({
  getAppSession: async () => ({ token: "fixture-session" }),
}));
vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://broadcast-fixture.invalid",
  apiUrl: (path: string) => `https://broadcast-fixture.invalid${path}`,
}));
type Destination = {
  id: string;
  displayName: string;
  position: number;
  retired: boolean;
  secretId: string;
  secretVersionId: string;
  retiredAt: string | null;
};
type Selection = { version: string; destinationIds: string[] };
const destination = (
  id: string,
  displayName: string,
  position: number,
  retired = false,
): Destination => ({
  id,
  displayName,
  position,
  retired,
  secretId: `fixture/public-reference/${id}`,
  secretVersionId: `public-fixture-version-${id}`,
  retiredAt: retired ? "2026-10-24T00:00:00Z" : null,
});
let catalog: Destination[];
let permissions: string[];
let requests: {
  method: string;
  path: string;
  body: any;
  authorization: string | undefined;
}[];
let failures: Record<string, number>;
let unexpected: string[];
let downstream: {
  requestedState: string;
  actualState: string;
  transition: string | null;
  readiness: boolean;
  destinations: {
    id: string;
    displayName: string;
    mode: string;
    supervisorHealthy: boolean;
    publisherProcessHealthy: boolean;
  }[];
  activeDestinations: Selection | null;
  pendingDestinations: Selection | null;
};
let available: boolean;
let hold: { path: string; promise: Promise<void>; release: () => void } | null;
function pause(path: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { path, promise, release };
  return release;
}
function apiResponse(
  config: InternalAxiosRequestConfig,
  value: unknown,
  status = 200,
) {
  return {
    config,
    data: structuredClone(value),
    status,
    statusText: "Fixture response",
    headers: {},
  };
}
async function adapter(config: InternalAxiosRequestConfig) {
  const path = config.url!;
  const method = config.method!.toUpperCase();
  const body =
    typeof config.data === "string"
      ? JSON.parse(config.data)
      : (config.data ?? null);
  requests.push({
    method,
    path,
    body,
    authorization: config.headers.Authorization as string | undefined,
  });
  if (hold?.path === path) await hold.promise;
  if (failures[`${method} ${path}`])
    throw new AxiosError(
      "Fixture request failed",
      AxiosError.ERR_BAD_RESPONSE,
      config,
      undefined,
      apiResponse(
        config,
        { error: "Fixture rejected broadcast action" },
        failures[`${method} ${path}`],
      ),
    );
  if (path === "/auth/me")
    return apiResponse(config, { authorization: { permissions } });
  if (method === "GET" && path === "/broadcast/programs/main")
    return apiResponse(config, {
      programId: "main",
      available,
      destinations: catalog.map(({ id, displayName, position, retired }) => ({
        id,
        displayName,
        position,
        retired,
      })),
      downstream,
    });
  if (method === "GET" && path === "/broadcast/destinations/catalog")
    return apiResponse(config, catalog);
  const command = path.match(
    /^\/broadcast\/programs\/main\/(reload|start|stop)$/,
  );
  if (method === "POST" && command) {
    const action = command[1];
    const selection = {
      version: "selection-1",
      destinationIds: body.destinationIds ?? [],
    };
    if (action === "reload") downstream.pendingDestinations = selection;
    if (action === "start")
      downstream = {
        ...downstream,
        requestedState: "running",
        actualState: "running",
        transition: null,
        activeDestinations: selection,
        pendingDestinations: null,
      };
    if (action === "stop")
      downstream = {
        ...downstream,
        requestedState: "stopped",
        actualState: "stopped",
        transition: null,
      };
    return apiResponse(config, {
      commandId: body.commandId,
      action,
      status: "acknowledged",
      selectionVersion: action === "stop" ? null : "selection-1",
    });
  }
  if (method === "POST" && path === "/broadcast/destinations") {
    catalog.push({
      ...body,
      position: catalog.length,
      retired: false,
      retiredAt: null,
    });
    return apiResponse(config, body);
  }
  if (method === "PUT" && path === "/broadcast/destinations/order") {
    catalog = body.destinationIds.map((id: string, position: number) => ({
      ...catalog.find((destination) => destination.id === id)!,
      position,
    }));
    return apiResponse(config, catalog);
  }
  const entry = path.match(
    /^\/broadcast\/destinations\/([^/]+)(?:\/(retire|restore))?$/,
  );
  if (entry) {
    const id = decodeURIComponent(entry[1]);
    if (method === "PUT") {
      catalog = catalog.map((destination) =>
        destination.id === id ? { ...destination, ...body } : destination,
      );
      return apiResponse(config, body);
    }
    if (method === "POST" && entry[2]) {
      const retired = entry[2] === "retire";
      catalog = catalog.map((destination) =>
        destination.id === id
          ? {
              ...destination,
              retired,
              retiredAt: retired ? "2026-10-24T00:00:00Z" : null,
            }
          : destination,
      );
      return apiResponse(config, {});
    }
  }
  unexpected.push(`${method} ${path}`);
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
}
const dialogDescriptors = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
beforeEach(() => {
  catalog = [
    destination("primary", "Primary platform", 0),
    destination("backup", "Backup platform", 1),
    destination("retired", "Retired platform", 2, true),
  ];
  permissions = ["broadcast.view", "broadcast.operate", "broadcast.manage"];
  requests = [];
  failures = {};
  unexpected = [];
  available = true;
  hold = null;
  downstream = {
    requestedState: "stopped",
    actualState: "stopped",
    transition: null,
    readiness: true,
    destinations: [
      {
        id: "primary",
        displayName: "Primary platform",
        mode: "direct",
        supervisorHealthy: true,
        publisherProcessHealthy: false,
      },
    ],
    activeDestinations: { version: "accepted-0", destinationIds: ["primary"] },
    pendingDestinations: null,
  };
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/operator-preferences/desktop") {
        unexpected.push(`fetch ${path}`);
        throw new Error(`Unexpected fetch: ${path}`);
      }
      return Response.json({
        version: 1,
        profile: {
          workspace: "director",
          dockWidth: 320,
          touchMode: false,
          shortcutsEnabled: true,
          selectedProgramId: "main",
          transitions: { main: "cut" },
        },
      });
    }),
  );
  api.defaults.adapter = adapter;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
});
afterEach(() => {
  hold?.release();
  // Bleecker notifications outlive component remounts; dismiss through their real UI.
  const alerts = screen.queryAllByRole("button", { name: "Close alert" });
  if (alerts.length) {
    vi.useFakeTimers();
    alerts.forEach((alert) => fireEvent.click(alert));
    act(() => {
      vi.advanceTimersByTime(220);
    });
  }
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  expect(unexpected).toEqual([]);
});
async function mount(expectDenied = false, controlledClock = false) {
  const store = legacy_createStore(reducers, {
    auth: {
      loaded: true,
      currentUser: { id: "operator-a", email: "operator@example.invalid" },
    },
    preferences: { selectedLanguage: "en" },
  } as any);
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <FeaturesProvider>
          <ConsolePreferencesProvider>
            <Broadcasts />
          </ConsolePreferencesProvider>
        </FeaturesProvider>
      </MemoryRouter>
    </Provider>,
  );
  if (controlledClock) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByText("Confirmed destination selection"),
    ).toBeInTheDocument();
  } else if (
    !expectDenied &&
    (permissions.includes("broadcast.view") || permissions.includes("*"))
  )
    await screen.findByText("Confirmed destination selection");
  else await screen.findByText("You do not have broadcast.view permission.");
  return view;
}
const writes = (path: string) =>
  requests.filter(
    (request) => request.path === path && request.method !== "GET",
  );
const checkbox = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(name) });
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Start broadcast" }),
  );
  await screen.findByText("Actual running");
}
it("loads state and the manager catalogue through authenticated real services", async () => {
  await mount();
  expect(screen.getByText("Requested stopped")).toBeInTheDocument();
  expect(screen.getByText("Actual stopped")).toBeInTheDocument();
  expect(screen.getByText("Alana reachable")).toBeInTheDocument();
  expect(screen.getByText("Pipeline ready")).toBeInTheDocument();
  expect(
    requests.find((request) => request.path === "/broadcast/programs/main")
      ?.authorization,
  ).toBe("Bearer fixture-session");
  expect(
    requests.find(
      (request) => request.path === "/broadcast/destinations/catalog",
    )?.authorization,
  ).toBe("Bearer fixture-session");
  expect(
    screen.getByText(/direct · supervisor healthy · publisher unhealthy/),
  ).toBeInTheDocument();
});
it("blocks state and catalogue access without view permission", async () => {
  permissions = [];
  await mount();
  expect(
    requests.some((request) => request.path.startsWith("/broadcast/")),
  ).toBe(false);
  expect(
    screen.queryByRole("button", { name: "Confirm Start" }),
  ).not.toBeInTheDocument();
});
it("permits inspection without operator or catalogue-manager controls", async () => {
  permissions = ["broadcast.view"];
  await mount();
  expect(checkbox("Primary platform")).toBeDisabled();
  expect(screen.getByText(/broadcast.operate is required/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Confirm Start" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Destination catalog")).not.toBeInTheDocument();
  expect(
    requests.some(
      (request) => request.path === "/broadcast/destinations/catalog",
    ),
  ).toBe(false);
});
it("lets operators select destinations without exposing catalogue references", async () => {
  permissions = ["broadcast.view", "broadcast.operate"];
  await mount();
  expect(checkbox("Primary platform")).toBeEnabled();
  expect(screen.queryByText(/public-fixture-version/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add destination" }),
  ).not.toBeInTheDocument();
});
it("lets catalogue managers inspect references while operation remains forbidden", async () => {
  permissions = ["broadcast.view", "broadcast.manage"];
  await mount();
  expect(screen.getByText("Destination catalog")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add destination" })).toBeEnabled();
  expect(checkbox("Primary platform")).toBeDisabled();
});
it("selects accepted active destinations and excludes retired entries from Start", async () => {
  await mount();
  expect(checkbox("Primary platform")).toBeChecked();
  expect(checkbox("Backup platform")).not.toBeChecked();
  expect(
    screen.queryByRole("checkbox", { name: /Retired platform/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Move Primary platform up" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Move Retired platform down" }),
  ).toBeDisabled();
});
it("prefers a pending selection over the previous active session", async () => {
  downstream.pendingDestinations = {
    version: "pending-1",
    destinationIds: ["backup"],
  };
  await mount();
  expect(checkbox("Backup platform")).toBeChecked();
  expect(checkbox("Primary platform")).not.toBeChecked();
});
it("disables Start and validation when the selected set becomes empty", async () => {
  await mount();
  fireEvent.click(checkbox("Primary platform"));
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reload while stopped" }),
  ).toBeDisabled();
});
it("does not send Start until the explicit second confirmation", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  await screen.findByRole("dialog", { name: "Confirm television Start" });
  expect(writes("/broadcast/programs/main/start")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes("/broadcast/programs/main/start")).toHaveLength(0);
});
it("starts exactly the selected destinations with a generated command identity", async () => {
  await mount();
  fireEvent.click(checkbox("Backup platform"));
  await start();
  expect(writes("/broadcast/programs/main/start")).toHaveLength(1);
  expect(writes("/broadcast/programs/main/start")[0].body).toEqual({
    commandId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    confirmed: true,
    destinationIds: ["primary", "backup"],
  });
  expect(checkbox("Primary platform")).toBeDisabled();
});
it("carries the validated selection version into Start", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByText("Validated selection-1");
  await start();
  expect(
    writes("/broadcast/programs/main/start")[0].body.selectionVersion,
  ).toBe("selection-1");
});
it("invalidates prior validation whenever destination selection changes", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByText("Validated selection-1");
  fireEvent.click(checkbox("Backup platform"));
  expect(screen.queryByText("Validated selection-1")).not.toBeInTheDocument();
  await start();
  expect(writes("/broadcast/programs/main/start")[0].body).not.toHaveProperty(
    "selectionVersion",
  );
});
it("confirms Stop and sends no replacement destination selection", async () => {
  downstream = {
    ...downstream,
    requestedState: "running",
    actualState: "running",
  };
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Stop" }));
  expect(writes("/broadcast/programs/main/stop")).toHaveLength(0);
  fireEvent.click(
    await screen.findByRole("button", { name: "Stop broadcast" }),
  );
  await screen.findByText("Actual stopped");
  expect(writes("/broadcast/programs/main/stop")[0].body).toEqual({
    commandId: expect.any(String),
    confirmed: true,
  });
});
it("disables mutation while the executor is unavailable", async () => {
  available = false;
  await mount();
  expect(screen.getByText("Alana unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm Stop" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reload while stopped" }),
  ).toBeDisabled();
});
it("keeps Reload unavailable during an acknowledged transition", async () => {
  downstream.transition = "stopping";
  downstream.readiness = false;
  await mount();
  expect(screen.getByText("stopping")).toBeInTheDocument();
  expect(screen.getByText("Pipeline not ready")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Reload while stopped" }),
  ).toBeDisabled();
});
it("offers no command when no non-retired destination exists", async () => {
  catalog = [destination("retired", "Retired platform", 0, true)];
  downstream.activeDestinations = null;
  await mount();
  expect(
    screen.getByText("No configured destinations are available."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
});
it("shows a rejected Start without claiming the executor is running", async () => {
  await mount();
  failures["POST /broadcast/programs/main/start"] = 409;
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Start broadcast" }),
  );
  await screen.findByText("Fixture rejected broadcast action");
  expect(screen.getByText("Actual stopped")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeEnabled();
});
it("holds all command controls while a validation request is in flight", async () => {
  await mount();
  const release = pause("/broadcast/programs/main/reload");
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByRole("button", { name: "Validating…" });
  expect(checkbox("Primary platform")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  release();
  await screen.findByText("Validated selection-1");
  expect(checkbox("Primary platform")).toBeEnabled();
});
const catalogRow = (name: string) =>
  screen.getByRole("button", { name: `Move ${name} up` }).parentElement!;
function fillCatalogForm(id = "new-platform") {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Opaque destination ID" }),
    { target: { value: id } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
    target: { value: "New platform" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Secrets Manager reference" }),
    { target: { value: "fixture/public-reference/new-platform" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Pinned secret version ID" }),
    { target: { value: "public-fixture-version-new" } },
  );
}
it("creates a catalogue entry using public pinned references without retrieving a secret", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await screen.findByRole("dialog", { name: "Add destination" });
  fillCatalogForm();
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  await screen.findByText("Destination created.");
  expect(writes("/broadcast/destinations")[0].body).toEqual({
    id: "new-platform",
    displayName: "New platform",
    secretId: "fixture/public-reference/new-platform",
    secretVersionId: "public-fixture-version-new",
  });
  await screen.findByRole("checkbox", { name: /New platform/ });
  expect(requests.some((request) => request.path.includes("/secrets/"))).toBe(
    false,
  );
});
it("cancels catalogue creation without publishing partial form data", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  fillCatalogForm();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes("/broadcast/destinations")).toHaveLength(0);
  expect(catalog).toHaveLength(3);
});
it("edits the pinned catalogue reference while keeping its opaque identity fixed", async () => {
  await mount();
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  await screen.findByRole("dialog", { name: "Edit destination" });
  expect(
    screen.getByRole("textbox", { name: "Opaque destination ID" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Secrets Manager reference" }),
  ).toHaveValue("fixture/public-reference/primary");
  fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
    target: { value: "Primary revised" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Pinned secret version ID" }),
    { target: { value: "public-fixture-version-revised" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  await screen.findByText("Destination updated.");
  expect(writes("/broadcast/destinations/primary")[0].body).toMatchObject({
    id: "primary",
    displayName: "Primary revised",
    secretVersionId: "public-fixture-version-revised",
  });
  await screen.findByRole("checkbox", { name: /Primary revised/ });
});
it("keeps rejected catalogue input available for correction", async () => {
  await mount();
  failures["POST /broadcast/destinations"] = 422;
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  fillCatalogForm();
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  await screen.findByText("Fixture rejected broadcast action");
  expect(
    screen.getByRole("dialog", { name: "Add destination" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "New platform",
  );
  expect(catalog).toHaveLength(3);
});
it("retains the saved catalogue when an edit is rejected", async () => {
  await mount();
  failures["PUT /broadcast/destinations/primary"] = 409;
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
    target: { value: "Rejected rename" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  await screen.findByText("Fixture rejected broadcast action");
  expect(catalog[0].displayName).toBe("Primary platform");
  expect(checkbox("Primary platform")).toBeInTheDocument();
});
it("shows a busy catalogue save and prevents duplicate submission", async () => {
  await mount();
  const release = pause("/broadcast/destinations");
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  fillCatalogForm();
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
  release();
  await screen.findByText("Destination created.");
  expect(writes("/broadcast/destinations")).toHaveLength(1);
});
it("retires a catalogue destination without mutating an active session", async () => {
  await mount();
  const acceptedSelection = structuredClone(downstream.activeDestinations);
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Retire",
    }),
  );
  await screen.findByText(
    "Destination retired. Active sessions are unchanged.",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: /Primary platform/ }),
    ).not.toBeInTheDocument(),
  );
  expect(downstream.activeDestinations).toEqual(acceptedSelection);
  expect(writes("/broadcast/destinations/primary/retire")).toHaveLength(1);
});
it("restores an explicitly retired destination into the selectable catalogue", async () => {
  await mount();
  fireEvent.click(
    within(catalogRow("Retired platform")).getByRole("button", {
      name: "Restore",
    }),
  );
  await screen.findByText("Destination restored.");
  await screen.findByRole("checkbox", { name: /Retired platform/ });
  expect(writes("/broadcast/destinations/retired/restore")).toHaveLength(1);
});
it("invalidates previously validated destinations when retiring a catalogue entry", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByText("Validated selection-1");
  fireEvent.click(
    within(catalogRow("Backup platform")).getByRole("button", {
      name: "Retire",
    }),
  );
  await screen.findByText(
    "Destination retired. Active sessions are unchanged.",
  );
  expect(screen.queryByText("Validated selection-1")).not.toBeInTheDocument();
});
it("preserves an entry if its retirement is rejected", async () => {
  await mount();
  failures["POST /broadcast/destinations/primary/retire"] = 409;
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Retire",
    }),
  );
  await screen.findByText("Fixture rejected broadcast action");
  expect(checkbox("Primary platform")).toBeInTheDocument();
  expect(catalog[0].retired).toBe(false);
});
it("moves a destination down and submits the complete ordered inventory", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Move Primary platform down" }),
  );
  await waitFor(() =>
    expect(writes("/broadcast/destinations/order")).toHaveLength(1),
  );
  expect(writes("/broadcast/destinations/order")[0].body).toEqual({
    destinationIds: ["backup", "primary", "retired"],
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Move .* up$/ })[0],
    ).toHaveAttribute("aria-label", "Move Backup platform up"),
  );
});
it("moves a later destination up without dropping retired catalogue entries", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Move Backup platform up" }),
  );
  await waitFor(() =>
    expect(writes("/broadcast/destinations/order")).toHaveLength(1),
  );
  expect(
    writes("/broadcast/destinations/order")[0].body.destinationIds,
  ).toEqual(["backup", "primary", "retired"]);
});
it("keeps the accepted catalogue order when a reorder fails", async () => {
  await mount();
  failures["PUT /broadcast/destinations/order"] = 409;
  fireEvent.click(
    screen.getByRole("button", { name: "Move Primary platform down" }),
  );
  await screen.findByText("Fixture rejected broadcast action");
  expect(catalog.map((destination) => destination.id)).toEqual([
    "primary",
    "backup",
    "retired",
  ]);
  expect(
    screen.getByRole("button", { name: "Move Primary platform up" }),
  ).toBeDisabled();
});
it("reports rejected validation without issuing Start or accepting a selection", async () => {
  await mount();
  failures["POST /broadcast/programs/main/reload"] = 503;
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByText("Fixture rejected broadcast action");
  expect(screen.queryByText("Validated selection-1")).not.toBeInTheDocument();
  expect(writes("/broadcast/programs/main/start")).toHaveLength(0);
});
it("does not claim Stop when the authoritative executor rejects it", async () => {
  downstream = {
    ...downstream,
    requestedState: "running",
    actualState: "running",
  };
  await mount();
  failures["POST /broadcast/programs/main/stop"] = 503;
  fireEvent.click(screen.getByRole("button", { name: "Confirm Stop" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Stop broadcast" }),
  );
  await screen.findByText("Fixture rejected broadcast action");
  expect(screen.getByText("Actual running")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm Stop" })).toBeEnabled();
});
it("does not load privileged broadcast data before permission context resolves", async () => {
  const release = pause("/auth/me");
  const pending = mount();
  await waitFor(() =>
    expect(requests.some((request) => request.path === "/auth/me")).toBe(true),
  );
  expect(
    screen.queryByText("Confirmed destination selection"),
  ).not.toBeInTheDocument();
  expect(
    requests.some((request) => request.path.startsWith("/broadcast/")),
  ).toBe(false);
  release();
  await pending;
  expect(
    screen.getByText("Confirmed destination selection"),
  ).toBeInTheDocument();
});
it("keeps the loading surface until the selected program state is available", async () => {
  const release = pause("/broadcast/programs/main");
  const pending = mount();
  await waitFor(() =>
    expect(
      requests.some((request) => request.path === "/broadcast/programs/main"),
    ).toBe(true),
  );
  expect(
    screen.queryByText("Confirmed destination selection"),
  ).not.toBeInTheDocument();
  release();
  await pending;
});
it("fails closed when authenticated permission context is unavailable", async () => {
  failures["GET /auth/me"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount(true);
  expect(
    requests.some((request) => request.path.startsWith("/broadcast/")),
  ).toBe(false);
  expect(errors).toHaveBeenCalledWith(
    "Failed to load user context",
    expect.any(AxiosError),
  );
});
it("reconciles the authoritative executor on its normal visible-page poll", async () => {
  vi.useFakeTimers();
  await mount(false, true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const initialLoads = requests.filter(
    (request) => request.path === "/broadcast/programs/main",
  ).length;
  downstream = {
    ...downstream,
    requestedState: "running",
    actualState: "running",
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    requests.filter((request) => request.path === "/broadcast/programs/main"),
  ).toHaveLength(initialLoads + 1);
  expect(screen.getByText("Actual running")).toBeInTheDocument();
  expect(checkbox("Primary platform")).toBeDisabled();
});
it("does not poll while the page is hidden", async () => {
  vi.useFakeTimers();
  await mount(false, true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const initialLoads = requests.filter(
    (request) => request.path === "/broadcast/programs/main",
  ).length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    requests.filter((request) => request.path === "/broadcast/programs/main"),
  ).toHaveLength(initialLoads);
});
it("retains operator selection when the server refreshes its active destination snapshot", async () => {
  vi.useFakeTimers();
  await mount(false, true);
  fireEvent.click(checkbox("Backup platform"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  downstream.activeDestinations = {
    version: "server-updated",
    destinationIds: ["backup"],
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(checkbox("Primary platform")).toBeChecked();
  expect(checkbox("Backup platform")).toBeChecked();
});
it("retains last acknowledged state after a transient polling error", async () => {
  vi.useFakeTimers();
  await mount(false, true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  failures["GET /broadcast/programs/main"] = 503;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText("Actual stopped")).toBeInTheDocument();
  expect(checkbox("Primary platform")).toBeChecked();
});
it("cancels the polling interval when the operator leaves", async () => {
  vi.useFakeTimers();
  const view = await mount(false, true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const initialLoads = requests.filter(
    (request) => request.path === "/broadcast/programs/main",
  ).length;
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(
    requests.filter((request) => request.path === "/broadcast/programs/main"),
  ).toHaveLength(initialLoads);
});
it("supports an empty active snapshot by selecting a current destination explicitly", async () => {
  downstream.activeDestinations = null;
  downstream.pendingDestinations = null;
  await mount();
  expect(checkbox("Primary platform")).not.toBeChecked();
  expect(checkbox("Backup platform")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  fireEvent.click(checkbox("Backup platform"));
  await start();
  expect(
    writes("/broadcast/programs/main/start")[0].body.destinationIds,
  ).toEqual(["backup"]);
});
it("renders distinct healthy and unhealthy relay telemetry from the executor", async () => {
  downstream.destinations = [
    {
      id: "backup",
      displayName: "Backup platform",
      mode: "standby",
      supervisorHealthy: false,
      publisherProcessHealthy: true,
    },
  ];
  await mount();
  expect(
    screen.getByText(/standby · supervisor unhealthy · publisher healthy/),
  ).toBeInTheDocument();
  expect(checkbox("Primary platform")).toBeInTheDocument();
});
it("reports a failed restore without making the retired destination selectable", async () => {
  await mount();
  failures["POST /broadcast/destinations/retired/restore"] = 409;
  fireEvent.click(
    within(catalogRow("Retired platform")).getByRole("button", {
      name: "Restore",
    }),
  );
  await screen.findByText("Fixture rejected broadcast action");
  expect(
    screen.queryByRole("checkbox", { name: /Retired platform/ }),
  ).not.toBeInTheDocument();
  expect(
    catalog.find((destination) => destination.id === "retired")?.retired,
  ).toBe(true);
});
it("supports the centrally granted wildcard permission without a separate bypass", async () => {
  permissions = ["*"];
  await mount();
  expect(checkbox("Primary platform")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add destination" })).toBeEnabled();
  expect(
    requests.some(
      (request) => request.path === "/broadcast/destinations/catalog",
    ),
  ).toBe(true);
});
it("cancels Stop without dispatching a command or changing the running session", async () => {
  downstream = {
    ...downstream,
    requestedState: "running",
    actualState: "running",
  };
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Stop" }));
  await screen.findByRole("dialog", { name: "Confirm television Stop" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes("/broadcast/programs/main/stop")).toHaveLength(0);
  expect(screen.getByText("Actual running")).toBeInTheDocument();
});
it("does not permit reloading or replacing selection while the executor is running", async () => {
  downstream = {
    ...downstream,
    requestedState: "running",
    actualState: "running",
  };
  await mount();
  expect(
    screen.getByRole("button", { name: "Reload while stopped" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  expect(checkbox("Primary platform")).toBeDisabled();
  expect(checkbox("Backup platform")).toBeDisabled();
});
it("keeps the Start confirmation busy until the authoritative acknowledgement arrives", async () => {
  await mount();
  const release = pause("/broadcast/programs/main/start");
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Start broadcast" }),
  );
  expect(
    await screen.findByRole("button", { name: "Sending…" }),
  ).toBeDisabled();
  expect(screen.getByText("Actual stopped")).toBeInTheDocument();
  release();
  await screen.findByText("Actual running");
  expect(writes("/broadcast/programs/main/start")).toHaveLength(1);
});
it("cancels catalogue editing without rewriting an accepted reference", async () => {
  await mount();
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Pinned secret version ID" }),
    { target: { value: "unsaved-public-fixture-version" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes("/broadcast/destinations/primary")).toHaveLength(0);
  expect(catalog[0].secretVersionId).toBe("public-fixture-version-primary");
});
it("encodes opaque destination identifiers when retiring a catalogue entry", async () => {
  catalog.push(destination("partner / west", "Partner platform", 3));
  await mount();
  fireEvent.click(
    within(catalogRow("Partner platform")).getByRole("button", {
      name: "Retire",
    }),
  );
  await screen.findByText(
    "Destination retired. Active sessions are unchanged.",
  );
  expect(
    writes("/broadcast/destinations/partner%20%2F%20west/retire"),
  ).toHaveLength(1);
  expect(
    catalog.find((destination) => destination.id === "partner / west")?.retired,
  ).toBe(true);
});
it.each(["/broadcast/programs/main", "/broadcast/destinations/catalog"])(
  "keeps execution disabled when initial %s context cannot be loaded",
  async (path) => {
    failures[`GET ${path}`] = 503;
    await mount();
    expect(screen.getByText("Requested unknown")).toBeInTheDocument();
    expect(screen.getByText("Actual unknown")).toBeInTheDocument();
    expect(screen.getByText("Alana unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("No configured destinations are available."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm Start" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm Stop" })).toBeDisabled();
    expect(
      requests.filter(
        (request) =>
          request.path.startsWith("/broadcast/") && request.method !== "GET",
      ),
    ).toHaveLength(0);
  },
);
it("closes Start confirmation through the real native dialog close control", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm television Start",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(writes("/broadcast/programs/main/start")).toHaveLength(0);
  expect(screen.getByText("Actual stopped")).toBeInTheDocument();
});
it("does not send a stale confirmation while a cancelled dialog animates out", async () => {
  await mount();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Start" }));
  const dialog = screen.getByRole("dialog", {
    name: "Confirm television Start",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  // Native dialog remains present during its 150 ms exit animation; a late
  // click must not acquire the authority that Cancel has already revoked.
  const staleAction = within(dialog).getByRole("button", {
    name: "Stop broadcast",
  });
  fireEvent.click(staleAction);
  expect(
    requests.filter(
      (request) =>
        request.path.startsWith("/broadcast/programs/") &&
        request.method === "POST",
    ),
  ).toHaveLength(0);
  act(() => {
    vi.advanceTimersByTime(150);
  });
});
it("closes catalogue editing through the native dialog without saving", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  const dialog = await screen.findByRole("dialog", { name: "Add destination" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(writes("/broadcast/destinations")).toHaveLength(0);
});
it("does not treat a stop request as an acknowledged stopped executor", async () => {
  downstream = {
    ...downstream,
    requestedState: "stopped",
    actualState: "running",
  };
  await mount();
  expect(screen.getByText("Requested stopped")).toBeInTheDocument();
  expect(screen.getByText("Actual running")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Reload while stopped" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm Stop" })).toBeEnabled();
});
it("encodes an opaque catalogue identity when updating its public reference", async () => {
  catalog.push(destination("partner / west", "Partner platform", 3));
  await mount();
  fireEvent.click(
    within(catalogRow("Partner platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Pinned secret version ID" }),
    { target: { value: "public-fixture-version-west-2" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
  await screen.findByText("Destination updated.");
  expect(
    writes("/broadcast/destinations/partner%20%2F%20west")[0].body,
  ).toMatchObject({
    id: "partner / west",
    secretVersionId: "public-fixture-version-west-2",
  });
});
it("clears the previous entry's immutable identity and reference when creating another destination", async () => {
  await mount();
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  expect(
    screen.getByRole("textbox", { name: "Opaque destination ID" }),
  ).toHaveValue("primary");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Edit destination" }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  expect(
    screen.getByRole("textbox", { name: "Opaque destination ID" }),
  ).toBeEnabled();
  for (const name of [
    "Opaque destination ID",
    "Display name",
    "Secrets Manager reference",
    "Pinned secret version ID",
  ])
    expect(screen.getByRole("textbox", { name })).toHaveValue("");
});
it("does not infer view authority from separate operate and manage permissions", async () => {
  permissions = ["broadcast.operate", "broadcast.manage"];
  await mount();
  expect(
    screen.getByText("You do not have broadcast.view permission."),
  ).toBeInTheDocument();
  expect(
    requests.some((request) => request.path.startsWith("/broadcast/")),
  ).toBe(false);
  expect(
    screen.queryByRole("button", { name: "Add destination" }),
  ).not.toBeInTheDocument();
});
it("retains the acknowledged active selection when pending selection is empty", async () => {
  downstream.pendingDestinations = {
    version: "empty-pending",
    destinationIds: [],
  };
  await mount();
  expect(checkbox("Primary platform")).toBeChecked();
  expect(checkbox("Backup platform")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm Start" })).toBeEnabled();
});
it("prevents a second catalogue mutation while an executor command is pending", async () => {
  await mount();
  const release = pause("/broadcast/programs/main/reload");
  fireEvent.click(screen.getByRole("button", { name: "Reload while stopped" }));
  await screen.findByRole("button", { name: "Validating…" });
  fireEvent.click(
    within(catalogRow("Primary platform")).getByRole("button", {
      name: "Edit",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Save destination" }),
  ).toBeDisabled();
  expect(writes("/broadcast/destinations/primary")).toHaveLength(0);
  release();
  await screen.findByText("Validated selection-1");
});
