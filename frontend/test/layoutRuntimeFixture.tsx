import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { Provider } from "react-redux";
import { legacy_createStore } from "redux";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useOutletContext,
} from "react-router";
import { ConsolePreferencesProvider } from "../app/contexts/ConsolePreferencesContext";
import { FeaturesProvider } from "../app/hooks/useFeatures";
import { reducers } from "../app/state/reducers";
import { api } from "../app/services/api";
import Layout from "../app/routes/layout";

const session = vi.hoisted(() => ({
  clear: vi.fn(async () => {}),
  testAuth: false,
}));
// Session-provider and browser/network adapters supply external boundaries;
// authentication state, router, preferences, navigation and commands remain real.
vi.mock("../app/services/session", () => ({
  getAppSession: async () => ({ token: "fixture-session" }),
  clearAppSession: session.clear,
  isTestAuth: () => session.testAuth,
}));
vi.mock("../app/utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://shell.example",
  apiUrl: (path: string) => `https://shell.example${path}`,
}));
let programs: {
  programId: string;
  type?: "tv" | "radio" | "both";
  templateManifest?: any;
}[];
let selectedProgram: string;
let permissions: string[];
let requests: { method: string; path: string; body: any }[];
let failures: Record<string, number>;
let unexpected: string[];
let clock: {
  timeOverrideEnabled: boolean;
  timeOverrideStartTime: string | null;
  timeOverrideStartedAt: string | null;
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const path = url.pathname + url.search;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, path, body });
  if (failures[`${method} ${url.pathname}`])
    return json(
      { message: "Fixture rejected command" },
      failures[`${method} ${url.pathname}`],
    );
  if (url.pathname === "/operator-preferences/desktop")
    return json({
      version: 1,
      profile: body?.profile ?? {
        workspace: "director",
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: selectedProgram,
        transitions: { [selectedProgram]: "cut" },
      },
    });
  if (path === "/program") return json(programs);
  if (path === "/scenes")
    return json([
      { id: 4, name: "Opening camera", layout: { name: "Camera template" } },
    ]);
  if (path === "/instants")
    return json([
      {
        id: 8,
        name: "News sting",
        enabled: true,
        volume: 0.7,
        position: 0,
        audioUrl: "https://media.example/sting.mp3",
      },
      {
        id: 9,
        name: "Disabled sting",
        enabled: false,
        volume: 1,
        position: 1,
        audioUrl: "https://media.example/disabled.mp3",
      },
    ]);
  if (path === "/program/broadcast-settings") {
    if (method === "PUT")
      clock = {
        timeOverrideEnabled: body.enabled,
        timeOverrideStartTime: body.startTime,
        timeOverrideStartedAt: "2026-10-24T12:00:00Z",
      };
    return json({ id: 1, updatedAt: "2026-10-24T12:00:00Z", ...clock });
  }
  if (
    method === "POST" &&
    (/^\/program\/[^/]+\/(reload|scenes|stage|song\/off-air)$/.test(
      url.pathname,
    ) ||
      /^\/instants\/(8\/play|stop-all)$/.test(url.pathname))
  )
    return json({});
  unexpected.push(`${method} ${path}`);
  return json({}, 500);
}
const dialogDescriptors = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
class BrowserPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
  }
}
const captureDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "hasPointerCapture",
);
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  vi.stubGlobal("PointerEvent", BrowserPointerEvent);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  programs = [
    { programId: "main", type: "tv" },
    { programId: "radio", type: "radio" },
    { programId: "simulcast", type: "both" },
  ];
  selectedProgram = "main";
  permissions = ["broadcast.view"];
  requests = [];
  failures = {};
  unexpected = [];
  clock = {
    timeOverrideEnabled: false,
    timeOverrideStartTime: null,
    timeOverrideStartedAt: null,
  };
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
  session.testAuth = false;
  session.clear.mockClear();
  session.clear.mockResolvedValue();
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.spyOn(window, "open").mockImplementation(() => null);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  api.defaults.adapter = async (config) => {
    if (config.url !== "/auth/me")
      throw new Error(`Unexpected Axios request: ${config.url}`);
    return {
      config,
      data: { authorization: { permissions } },
      status: 200,
      statusText: "OK",
      headers: {},
    };
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (captureDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "hasPointerCapture",
      captureDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
  if (scrollDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  expect(unexpected).toEqual([]);
});
function RouteProbe() {
  const location = useLocation();
  const context = useOutletContext<{ programType: string | null }>();
  return (
    <>
      <p data-testid="location">
        {location.pathname}
        {location.hash}
      </p>
      <p data-testid="program-type">{context.programType ?? "unresolved"}</p>
    </>
  );
}
async function mount(path = "/songs", expectedType?: string) {
  const store = legacy_createStore(reducers, {
    auth: {
      loaded: true,
      currentUser: { id: "operator-a", email: "operator@example.invalid" },
    },
    preferences: { selectedLanguage: "en" },
  } as any);
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [{ path: "*", element: <RouteProbe /> }],
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <Provider store={store}>
      <FeaturesProvider>
        <ConsolePreferencesProvider>
          <RouterProvider router={router} />
        </ConsolePreferencesProvider>
      </FeaturesProvider>
    </Provider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("program-type")).toHaveTextContent(
      expectedType ??
        programs.find((program) => program.programId === selectedProgram)
          ?.type ??
        "tv",
    ),
  );
  await waitFor(() =>
    expect(requests.some((request) => request.path === "/instants")).toBe(true),
  );
  for (const name of ["Live", "Show setup"]) {
    const section = screen.queryByRole("button", { name });
    if (section?.getAttribute("aria-expanded") === "false")
      fireEvent.click(section);
  }
  return { ...view, store, router };
}
async function command(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  const input = await screen.findByPlaceholderText(
    "Search pages, programs, scenes, transitions, and broadcast...",
  );
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(
    (await screen.findByText(name, { exact: true, selector: "p" })).closest(
      "button",
    )!,
  );
}
const writes = (path: string) =>
  requests.filter(
    (request) => request.path === path && request.method !== "GET",
  );

export { mount, command, writes, session, programs, requests, failures, clock };
export function setSelectedProgram(value: string) {
  selectedProgram = value;
}
export function setPermissions(value: string[]) {
  permissions = value;
}
export function setClock(value: typeof clock) {
  clock = value;
}
