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
import { ConsolePreferencesProvider } from "../contexts/ConsolePreferencesContext";
import { reducers } from "../state/reducers";
import RadioSettings from "./radio-settings";
vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://radio-settings-fixture.invalid",
  apiUrl: (path: string) => `https://radio-settings-fixture.invalid${path}`,
}));
// Exercise real providers, settings/consumer editing and the recovery panel.
// Fictional HTTP data contains public fixture headers, never real credentials.
let programId: string;
let settings: {
  palazzoUrl: string;
  bumperEnabled: boolean;
  bumperInterval: number | null;
  bumperInstantIds: number[];
  bumperMode: string | null;
  enabled: boolean;
};
let consumers: any;
let songs: any;
let instants: any;
let recovery: {
  selectedSongIds: number[];
  preparedVersion: string | null;
  automation: {
    actualState: string;
    filler: { activeVersion: string | null; ready: boolean };
  } | null;
  connection: "connected" | "unavailable";
};
let failures: Record<string, { status: number; body: string }>;
let networkFailures: Record<string, unknown>;
let requests: { path: string; method: string; body: any }[];
let unexpected: string[];
let hold: { path: string; promise: Promise<void>; release: () => void } | null;
function pause(path: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { path, promise, release };
  return release;
}
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const path = url.pathname + url.search;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ path, method, body });
  if (hold?.path === path) await hold.promise;
  if (Object.hasOwn(networkFailures, `${method} ${path}`))
    throw networkFailures[`${method} ${path}`];
  const failure = failures[`${method} ${path}`];
  if (failure) return new Response(failure.body, { status: failure.status });
  if (path === "/operator-preferences/desktop")
    return Response.json({
      version: 1,
      profile: {
        workspace: "director",
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: programId,
        transitions: { [programId]: "cut" },
      },
    });
  if (/^\/radio\/[^/]+\/settings$/.test(path)) {
    if (method === "PUT") settings = body;
    return Response.json(settings);
  }
  if (/^\/radio\/[^/]+\/now-playing-consumers$/.test(path)) {
    if (method === "PUT")
      consumers = body.consumers.map((consumer: any, index: number) => ({
        id: index + 1,
        ...consumer,
      }));
    return Response.json(consumers);
  }
  if (path === "/instants") return Response.json(instants);
  if (path === "/songs?page=1&limit=1000") return Response.json(songs);
  if (/^\/radio\/[^/]+\/recovery$/.test(path)) return Response.json(recovery);
  if (/^\/radio\/[^/]+\/recovery\/prepare$/.test(path) && method === "POST") {
    recovery = {
      ...recovery,
      selectedSongIds: body.songIds,
      preparedVersion: "prepared-fixture-1",
    };
    return Response.json(recovery);
  }
  unexpected.push(`${method} ${path}`);
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
}
class BrowserPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
  }
}
const browserDescriptors = new Map(
  ["scrollIntoView", "hasPointerCapture"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  ]),
);
beforeEach(() => {
  vi.stubGlobal("PointerEvent", BrowserPointerEvent);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  programId = "main";
  requests = [];
  failures = {};
  networkFailures = {};
  unexpected = [];
  hold = null;
  settings = {
    palazzoUrl: "https://palazzo-fixture.invalid",
    bumperEnabled: true,
    bumperInterval: 4,
    bumperInstantIds: [8],
    bumperMode: "sequential",
    enabled: true,
  };
  consumers = [
    {
      id: 1,
      name: "Public fixture consumer",
      url: "https://consumer-fixture.invalid/now-playing",
      method: "POST",
      headers: { "X-Public-Fixture": "fixture-value" },
      enabled: true,
    },
  ];
  instants = [
    { id: 8, name: "News sting", enabled: true },
    { id: 9, name: "Station ID", enabled: true },
    { id: 10, name: "Disabled sting", enabled: false },
  ];
  songs = {
    data: [
      { id: 11, title: "First song", artist: "Studio artist", enabled: true },
      { id: 12, title: "Second song", artist: "Studio artist", enabled: true },
      {
        id: 13,
        title: "Disabled song",
        artist: "Studio artist",
        enabled: false,
      },
    ],
  };
  recovery = {
    selectedSongIds: [11],
    preparedVersion: null,
    automation: null,
    connection: "connected",
  };
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
});
afterEach(() => {
  hold?.release();
  const alerts = screen.queryAllByRole("button", { name: "Close alert" });
  if (alerts.length) {
    vi.useFakeTimers();
    alerts.forEach((alert) => fireEvent.click(alert));
    act(() => {
      vi.advanceTimersByTime(220);
    });
  }
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of browserDescriptors) {
    if (descriptor)
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  expect(unexpected).toEqual([]);
});
async function mount(unavailable = false) {
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
        <ConsolePreferencesProvider>
          <RadioSettings />
        </ConsolePreferencesProvider>
      </MemoryRouter>
    </Provider>,
  );
  if (unavailable) await screen.findByText("Radio configuration unavailable");
  else {
    await screen.findByRole("heading", { name: "Radio playout" });
    await waitFor(() =>
      expect(
        requests.some((request) => request.path.endsWith("/recovery")),
      ).toBe(true),
    );
  }
  await waitFor(() =>
    expect(
      screen.getByText(/Automation, Palazzo, and metadata delivery/),
    ).toHaveTextContent(programId),
  );
  return view;
}
const writes = (path: string) =>
  requests.filter(
    (request) => request.path === path && request.method !== "GET",
  );
const card = (name = "Public fixture consumer") =>
  screen.getByRole("button", { name: `Remove ${name}` }).closest("section")!;
it("loads real automation, now-playing and recovery state for the accepted program", async () => {
  await mount();
  expect(
    screen.getByRole("textbox", { name: "Palazzo control URL" }),
  ).toHaveValue("https://palazzo-fixture.invalid");
  expect(
    screen.getByRole("checkbox", { name: "Enable Alcántara radio automation" }),
  ).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "News sting" })).toBeChecked();
  expect(
    screen.queryByRole("checkbox", { name: "Disabled sting" }),
  ).not.toBeInTheDocument();
  expect(within(card()).getByLabelText("Header value")).toHaveAttribute(
    "type",
    "password",
  );
  expect(
    requests.some((request) => request.path === "/radio/main/recovery"),
  ).toBe(true);
});
it("saves automation and Palazzo settings through the actual form", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Enable Alcántara radio automation" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Palazzo control URL" }),
    { target: { value: "https://revised-palazzo-fixture.invalid" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Insert every N songs" }),
    { target: { value: "7" } },
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "News sting" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Station ID" }));
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  await screen.findByText("Radio distribution settings saved.");
  expect(writes("/radio/main/settings")[0].body).toMatchObject({
    enabled: false,
    palazzoUrl: "https://revised-palazzo-fixture.invalid",
    bumperInterval: 7,
    bumperInstantIds: [9],
  });
});
it("hides bumper controls when disabled and preserves the setting on save", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Insert station IDs and bumpers" }),
  );
  expect(
    screen.queryByRole("spinbutton", { name: "Insert every N songs" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  await screen.findByText("Radio distribution settings saved.");
  expect(writes("/radio/main/settings")[0].body.bumperEnabled).toBe(false);
});
it("normalizes an empty interval to the supported default representation", async () => {
  await mount();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Insert every N songs" }),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  await screen.findByText("Radio distribution settings saved.");
  expect(writes("/radio/main/settings")[0].body.bumperInterval).toBeNull();
});
it("shows defaults for an accepted null bumper interval and order", async () => {
  settings.bumperMode = null;
  settings.bumperInterval = null;
  await mount();
  expect(
    screen.getByRole("spinbutton", { name: "Insert every N songs" }),
  ).toHaveValue(4);
  expect(screen.getByText("Sequential")).toBeInTheDocument();
});
it("saves trimmed consumer fields and public header drafts", async () => {
  await mount();
  const section = card();
  fireEvent.change(within(section).getByRole("textbox", { name: "Name" }), {
    target: { value: "  Revised consumer  " },
  });
  fireEvent.change(within(section).getByRole("textbox", { name: "URL" }), {
    target: { value: " https://revised-consumer-fixture.invalid/now-playing " },
  });
  fireEvent.change(
    within(section).getByRole("textbox", { name: "Header name" }),
    { target: { value: " X-Public-Revision " } },
  );
  fireEvent.change(within(section).getByLabelText("Header value"), {
    target: { value: " public-fixture-value " },
  });
  fireEvent.click(within(section).getByRole("checkbox", { name: "Enabled" }));
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Now-playing delivery saved.");
  expect(writes("/radio/main/now-playing-consumers")[0].body).toEqual({
    consumers: [
      {
        name: "Revised consumer",
        url: "https://revised-consumer-fixture.invalid/now-playing",
        method: "POST",
        headers: { "X-Public-Revision": "public-fixture-value" },
        enabled: false,
      },
    ],
  });
});
it("adds and removes consumers through actual editor controls", async () => {
  consumers = [];
  await mount();
  expect(screen.getByText("No consumers configured")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add consumer" }));
  expect(
    within(card("consumer-1")).getByRole("checkbox", { name: "Enabled" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Remove consumer-1" }));
  expect(screen.getByText("No consumers configured")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Now-playing delivery saved.");
  expect(writes("/radio/main/now-playing-consumers")[0].body).toEqual({
    consumers: [],
  });
});
it("adds and removes header drafts without leaking them into another consumer", async () => {
  consumers.push({
    id: 2,
    name: "Other consumer",
    url: "https://other-consumer-fixture.invalid",
    method: "POST",
    headers: {},
    enabled: true,
  });
  await mount();
  const section = card();
  fireEvent.click(within(section).getByRole("button", { name: "Add header" }));
  expect(within(section).getAllByLabelText("Header name")).toHaveLength(2);
  expect(
    within(card("Other consumer")).queryByLabelText("Header name"),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(section).getAllByRole("button", { name: "Remove header" })[0],
  );
  expect(within(section).getAllByLabelText("Header name")).toHaveLength(1);
});
it("rejects a header value without a name before submitting consumer data", async () => {
  await mount();
  const section = card();
  fireEvent.click(within(section).getByRole("button", { name: "Add header" }));
  fireEvent.change(within(section).getAllByLabelText("Header value")[1], {
    target: { value: "public-fixture-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Consumer 1: header name is required");
  expect(writes("/radio/main/now-playing-consumers")).toHaveLength(0);
});
it("omits incomplete blank-value header drafts from the persisted consumer", async () => {
  await mount();
  const section = card();
  fireEvent.click(within(section).getByRole("button", { name: "Add header" }));
  fireEvent.change(within(section).getAllByLabelText("Header name")[1], {
    target: { value: "Unfilled-public-header" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Now-playing delivery saved.");
  expect(
    writes("/radio/main/now-playing-consumers")[0].body.consumers[0].headers,
  ).toEqual({ "X-Public-Fixture": "fixture-value" });
});
it("shows accepted recovery selection without offering disabled songs", async () => {
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByRole("checkbox", {
    name: "Studio artist — First song",
  });
  expect(
    within(section).getByRole("checkbox", {
      name: "Studio artist — First song",
    }),
  ).toBeChecked();
  expect(
    within(section).queryByRole("checkbox", { name: /Disabled song/ }),
  ).not.toBeInTheDocument();
  expect(within(section).getByText("Not prepared")).toBeInTheDocument();
});
it("prepares exactly the operator-selected recovery songs", async () => {
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  fireEvent.click(
    await within(section).findByRole("checkbox", {
      name: "Studio artist — Second song",
    }),
  );
  fireEvent.click(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  );
  await within(section).findByText("Prepared");
  expect(writes("/radio/main/recovery/prepare")[0].body).toEqual({
    songIds: [11, 12],
  });
});
it("marks changed recovery selection as requiring fresh preparation", async () => {
  recovery.preparedVersion = "accepted-preparation";
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  fireEvent.click(
    await within(section).findByRole("checkbox", {
      name: "Studio artist — Second song",
    }),
  );
  expect(
    within(section).getByText(
      "Selection changed. Prepare it before starting a new session.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(
    within(section).getByRole("checkbox", {
      name: "Studio artist — Second song",
    }),
  );
  expect(
    within(section).queryByText(
      "Selection changed. Prepare it before starting a new session.",
    ),
  ).not.toBeInTheDocument();
});
it("does not claim session readiness while Palazzo is unavailable", async () => {
  recovery.connection = "unavailable";
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText(/Palazzo is unavailable/);
  expect(
    within(section).getByText(/session readiness cannot be verified/),
  ).toBeInTheDocument();
});
it("identifies recovery already active in an acknowledged Palazzo session", async () => {
  recovery.automation = {
    actualState: "running",
    filler: { activeVersion: "active-fixture-1", ready: true },
  };
  recovery.preparedVersion = "active-fixture-1";
  await mount();
  await screen.findByText(
    "A recovery playlist is active in the current Palazzo session.",
  );
});
it("does not allow an empty recovery selection to be prepared", async () => {
  recovery.selectedSongIds = [];
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByRole("checkbox", {
    name: "Studio artist — First song",
  });
  expect(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  ).toBeDisabled();
});
it("refreshes the actual recovery snapshot independently of configuration saves", async () => {
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByRole("checkbox", {
    name: "Studio artist — First song",
  });
  recovery.preparedVersion = "server-prepared";
  fireEvent.click(
    within(section).getByRole("button", { name: "Refresh status" }),
  );
  await within(section).findByText("Prepared");
  expect(
    requests.filter((request) => request.path === "/radio/main/recovery"),
  ).toHaveLength(2);
  expect(writes("/radio/main/settings")).toHaveLength(0);
});
it.each([
  ["/radio/main/settings", "Radio settings failed (503)"],
  ["/radio/main/now-playing-consumers", "Now-playing delivery failed (503)"],
  ["/instants", "Audio clips failed (503)"],
])(
  "keeps configuration unavailable when required %s context fails",
  async (path, message) => {
    failures[`GET ${path}`] = { status: 503, body: "Fixture unavailable" };
    await mount(true);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save radio settings" }),
    ).not.toBeInTheDocument();
    expect(requests.some((request) => request.path.endsWith("/recovery"))).toBe(
      false,
    );
  },
);
it("retries a failed initial load without requiring an unrelated mutation", async () => {
  failures["GET /radio/main/settings"] = {
    status: 503,
    body: "Fixture unavailable",
  };
  await mount(true);
  delete failures["GET /radio/main/settings"];
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Radio playout" });
  expect(
    requests.filter(
      (request) =>
        request.path === "/radio/main/settings" && request.method === "GET",
    ),
  ).toHaveLength(2);
  expect(writes("/radio/main/settings")).toHaveLength(0);
});
it("reports a non-Error initial transport rejection without inventing configuration", async () => {
  networkFailures["GET /radio/main/settings"] = "opaque fixture failure";
  await mount(true);
  expect(
    screen.getByText("Radio configuration could not be loaded."),
  ).toBeInTheDocument();
});
it("keeps edited automation state available after a rejected save", async () => {
  await mount();
  failures["PUT /radio/main/settings"] = {
    status: 503,
    body: "Fixture unavailable",
  };
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Enable Alcántara radio automation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  await screen.findByText("Radio settings were not saved (503)");
  expect(settings.enabled).toBe(true);
  expect(
    screen.getByRole("checkbox", { name: "Enable Alcántara radio automation" }),
  ).not.toBeChecked();
});
it("does not claim consumer publication when the backend rejects it", async () => {
  await mount();
  failures["PUT /radio/main/now-playing-consumers"] = {
    status: 409,
    body: "Fixture conflict",
  };
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Now-playing delivery was not saved (409)");
  expect(
    screen.queryByText("Now-playing delivery saved."),
  ).not.toBeInTheDocument();
});
it.each([
  [
    "/radio/main/settings",
    "Save radio settings",
    "Radio settings were not saved.",
  ],
  [
    "/radio/main/now-playing-consumers",
    "Save consumers",
    "Now-playing delivery was not saved.",
  ],
])("handles non-Error %s write failures", async (path, button, message) => {
  await mount();
  networkFailures[`PUT ${path}`] = "opaque fixture failure";
  fireEvent.click(screen.getByRole("button", { name: button }));
  await screen.findByText(message);
});
it("blocks duplicate settings writes until the first response settles", async () => {
  await mount();
  const release = pause("/radio/main/settings");
  const save = screen.getByRole("button", { name: "Save radio settings" });
  fireEvent.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(save).toHaveAttribute("aria-busy", "true");
  release();
  await screen.findByText("Radio distribution settings saved.");
  expect(writes("/radio/main/settings")).toHaveLength(1);
});
it("blocks duplicate consumer writes while publishing the accepted draft", async () => {
  await mount();
  const release = pause("/radio/main/now-playing-consumers");
  const save = screen.getByRole("button", { name: "Save consumers" });
  fireEvent.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(save).toHaveAttribute("aria-busy", "true");
  release();
  await screen.findByText("Now-playing delivery saved.");
  expect(writes("/radio/main/now-playing-consumers")).toHaveLength(1);
});
it("normalizes incomplete consumer context to editable empty fields", async () => {
  consumers = [null];
  await mount();
  const section = card("consumer 1");
  expect(within(section).getByRole("textbox", { name: "Name" })).toHaveValue(
    "",
  );
  expect(within(section).getByRole("textbox", { name: "URL" })).toHaveValue("");
  expect(within(section).getByText("POST")).toBeInTheDocument();
  expect(
    within(section).getByRole("checkbox", { name: "Enabled" }),
  ).toBeChecked();
  expect(
    within(section).queryByLabelText("Header name"),
  ).not.toBeInTheDocument();
});
it.each([null, ["array is not a header record"], "not a header record"])(
  "does not reinterpret malformed header context as request headers (%s)",
  async (headers) => {
    consumers[0].headers = headers;
    await mount();
    expect(
      within(card()).queryByLabelText("Header name"),
    ).not.toBeInTheDocument();
  },
);
it("normalizes non-string consumer fields and explicit disabled state safely", async () => {
  consumers = [
    {
      id: "opaque invalid number",
      name: 7,
      url: false,
      method: 9,
      headers: { "X-Public-Number": 17 },
      enabled: false,
    },
  ];
  await mount();
  const section = card("consumer 1");
  expect(within(section).getByRole("textbox", { name: "Name" })).toHaveValue(
    "",
  );
  expect(
    within(section).getByRole("checkbox", { name: "Enabled" }),
  ).not.toBeChecked();
  expect(within(section).getByLabelText("Header value")).toHaveValue("17");
});
it("does not invent consumers or clips from non-array catalogues", async () => {
  consumers = { malformed: true };
  instants = { malformed: true };
  await mount();
  expect(screen.getByText("No consumers configured")).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "News sting" }),
  ).not.toBeInTheDocument();
});
it("reports missing song and recovery context through the real recovery panel", async () => {
  failures["GET /songs?page=1&limit=1000"] = {
    status: 503,
    body: "Fixture unavailable",
  };
  await mount();
  await within(
    screen.getByRole("region", { name: "Recovery playlist" }),
  ).findByText("Catalog songs are unavailable.");
});
it("reports an unavailable recovery configuration without claiming preparation", async () => {
  failures["GET /radio/main/recovery"] = {
    status: 503,
    body: "Fixture unavailable",
  };
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText("Recovery configuration is unavailable.");
  expect(within(section).getByText("Not prepared")).toBeInTheDocument();
});
it("renders an empty recovery catalogue without treating it as prepared", async () => {
  songs = { data: {} };
  recovery.selectedSongIds = [];
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText("No enabled catalog songs are available.");
  expect(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  ).toBeDisabled();
});
it.each([
  [
    JSON.stringify({ message: "Fixture files could not be verified" }),
    "Fixture files could not be verified",
  ],
  ["not JSON", "Preparation failed (503)"],
  [JSON.stringify({ message: 7 }), "Preparation failed (503)"],
])(
  "keeps rejected recovery preparation distinct from a prepared session (%s)",
  async (body, message) => {
    failures["POST /radio/main/recovery/prepare"] = { status: 503, body };
    await mount();
    const section = screen.getByRole("region", { name: "Recovery playlist" });
    await within(section).findByRole("checkbox", {
      name: "Studio artist — First song",
    });
    fireEvent.click(
      within(section).getByRole("button", { name: "Prepare playlist" }),
    );
    await within(section).findByText(message);
    expect(within(section).getByText("Not prepared")).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Prepare playlist" }),
    ).toBeEnabled();
  },
);
it("handles non-Error recovery load and prepare rejections separately", async () => {
  networkFailures["GET /radio/main/recovery"] = "opaque fixture load failure";
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText("Recovery status failed.");
  delete networkFailures["GET /radio/main/recovery"];
  fireEvent.click(
    within(section).getByRole("button", { name: "Refresh status" }),
  );
  await waitFor(() =>
    expect(
      within(section).getByRole("checkbox", {
        name: "Studio artist — First song",
      }),
    ).toBeChecked(),
  );
  networkFailures["POST /radio/main/recovery/prepare"] =
    "opaque fixture prepare failure";
  fireEvent.click(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  );
  await within(section).findByText("Recovery preparation failed.");
});
it("keeps recovery preparation bound to the submitted selection if editing continues", async () => {
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByRole("checkbox", {
    name: "Studio artist — First song",
  });
  const release = pause("/radio/main/recovery/prepare");
  fireEvent.click(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  );
  expect(
    await within(section).findByRole("button", {
      name: "Preparing in Palazzo…",
    }),
  ).toBeDisabled();
  expect(
    within(section).getByRole("button", { name: "Refresh status" }),
  ).toBeDisabled();
  fireEvent.click(
    within(section).getByRole("checkbox", {
      name: "Studio artist — Second song",
    }),
  );
  release();
  await within(section).findByText(
    "Selection changed. Prepare it before starting a new session.",
  );
  expect(writes("/radio/main/recovery/prepare")[0].body).toEqual({
    songIds: [11],
  });
});
it("rejects over-limit recovery selection before posting a preparation command", async () => {
  recovery.selectedSongIds = Array.from(
    { length: 101 },
    (_, index) => index + 1,
  );
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByRole("checkbox", {
    name: "Studio artist — First song",
  });
  expect(
    within(section).getByRole("button", { name: "Prepare playlist" }),
  ).toBeDisabled();
  expect(writes("/radio/main/recovery/prepare")).toHaveLength(0);
});
it("holds all configuration controls until required settings responses settle", async () => {
  const release = pause("/radio/main/settings");
  const pending = mount();
  await waitFor(() =>
    expect(
      requests.some((request) => request.path === "/radio/main/settings"),
    ).toBe(true),
  );
  expect(
    screen.queryByRole("button", { name: "Save radio settings" }),
  ).not.toBeInTheDocument();
  release();
  await pending;
});
it("encodes the accepted program context for settings, consumers and recovery writes", async () => {
  programId = "studio / west";
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  await screen.findByText("Radio distribution settings saved.");
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  await screen.findByText("Now-playing delivery saved.");
  expect(writes("/radio/studio%20%2F%20west/settings")).toHaveLength(1);
  expect(
    writes("/radio/studio%20%2F%20west/now-playing-consumers"),
  ).toHaveLength(1);
  expect(
    requests.some(
      (request) => request.path === "/radio/studio%20%2F%20west/recovery",
    ),
  ).toBe(true);
});
it("distinguishes stored recovery preparation from an active session", async () => {
  recovery.preparedVersion = "accepted-preparation";
  recovery.automation = {
    actualState: "stopped",
    filler: { activeVersion: null, ready: true },
  };
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText("Prepared");
  expect(
    within(section).queryByText(
      "A recovery playlist is active in the current Palazzo session.",
    ),
  ).not.toBeInTheDocument();
});
it("keeps stored preparation distinct from unavailable live-session readiness", async () => {
  recovery.preparedVersion = "accepted-preparation";
  recovery.connection = "unavailable";
  await mount();
  const section = screen.getByRole("region", { name: "Recovery playlist" });
  await within(section).findByText("Prepared");
  expect(
    within(section).getByText(/session readiness cannot be verified/),
  ).toBeInTheDocument();
  expect(
    within(section).queryByText(
      "A recovery playlist is active in the current Palazzo session.",
    ),
  ).not.toBeInTheDocument();
});
it.each<[unknown, string]>([
  [
    new Error("Fixture refresh transport error"),
    "Fixture refresh transport error",
  ],
  ["opaque fixture refresh failure", "Recovery status failed."],
])(
  "reports rejected manual recovery refresh without replacing acknowledged selection (%s)",
  async (failure, message) => {
    await mount();
    const section = screen.getByRole("region", { name: "Recovery playlist" });
    await within(section).findByRole("checkbox", {
      name: "Studio artist — First song",
    });
    networkFailures["GET /radio/main/recovery"] = failure;
    fireEvent.click(
      within(section).getByRole("button", { name: "Refresh status" }),
    );
    await within(section).findByText(message);
    expect(
      within(section).getByRole("checkbox", {
        name: "Studio artist — First song",
      }),
    ).toBeChecked();
  },
);
function chooseOption(trigger: HTMLElement, label: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
    clientX: 10,
    clientY: 10,
  });
  const option = screen.getByRole("option", { name: label });
  fireEvent.pointerMove(option, {
    pointerType: "mouse",
    clientX: 20,
    clientY: 100,
  });
  fireEvent.pointerDown(option, {
    pointerType: "mouse",
    clientX: 20,
    clientY: 100,
  });
  fireEvent.pointerUp(option, {
    pointerType: "mouse",
    clientX: 20,
    clientY: 100,
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
}
it("binds actual bumper-order and consumer-method choices to their separate outgoing requests", async () => {
  await mount();
  await waitFor(() =>
    expect(
      localStorage.getItem("alcantara.console.acknowledged.operator-a.desktop"),
    ).not.toBeNull(),
  );
  vi.useFakeTimers();
  const field = screen.getByText("Bumper order", { selector: "label" })
    .parentElement!.parentElement!;
  const bumper = within(field).getByRole("combobox");
  chooseOption(bumper, "Random");
  expect(bumper).toHaveTextContent("Random");
  const method = within(card()).getByRole("combobox");
  chooseOption(method, "PATCH");
  expect(method).toHaveTextContent("PATCH");
  fireEvent.click(screen.getByRole("button", { name: "Save radio settings" }));
  // These boundaries check each exact submitted draft; acknowledged publication
  // and rejection paths are independently exercised by normal transport cases.
  expect(writes("/radio/main/settings")).toHaveLength(1);
  expect(writes("/radio/main/settings")[0].body.bumperMode).toBe("random");
  fireEvent.click(screen.getByRole("button", { name: "Save consumers" }));
  expect(writes("/radio/main/now-playing-consumers")).toHaveLength(1);
  expect(
    writes("/radio/main/now-playing-consumers")[0].body.consumers[0].method,
  ).toBe("PATCH");
  act(() => {
    vi.advanceTimersByTime(0);
  });
});
