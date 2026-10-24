import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import MediaRoute from "../app/routes/media";
import type { ProgramType } from "../app/utils/appNavigation";

// Authentication, HTTP and browser file/dialog capabilities are boundaries;
// the route, upload service, label pagination, widgets and forms remain real.
vi.mock("../app/services/session", () => ({
  getAppSession: async () => ({ token: "media-runtime-fixture" }),
}));
vi.mock("../app/utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://media.example",
  apiUrl: (path: string) => `https://media.example${path}`,
}));

type Asset = {
  id: string;
  name: string;
  sourceUrl: string;
  mediaType: "IMAGE" | "AUDIO" | "VIDEO";
  enabled: boolean;
  capabilities: string[];
  image: { id: number } | null;
  instant: { id: number; volume: number } | null;
  background: { defaultVolume: number } | null;
  song: {
    id: number;
    artist: string;
    title: string;
    coverUrl: string | null;
    durationMs: number | null;
  } | null;
  coverForSongIds: number[];
  transition: { id: number; cutPointMs: number } | null;
  updatedAt: string;
};
type Label = { id: string; name: string; description: string | null };
type Request = { method: string; path: string; body: any; headers: Headers };
type Failure =
  | Response
  | Error
  | string
  | (() => Response | Error | string | undefined);
let assets: Asset[];
let labels: Label[];
let membership: Record<string, string[]>;
let requests: Request[];
let failures: Record<string, Failure>;
let unexpected: string[];
let pageCount: number;
let assetSequence: number;
let gates: Partial<Record<string, Promise<void>>>;

function asset(
  id: string,
  name: string,
  overrides: Partial<Asset> = {},
): Asset {
  return {
    id,
    name,
    sourceUrl: `https://cdn.fixture.invalid/${id}.jpg`,
    mediaType: "IMAGE",
    enabled: true,
    capabilities: [],
    image: { id: Number(id.split(":")[1]) || 1 },
    instant: null,
    background: null,
    song: null,
    coverForSongIds: [],
    transition: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
function presentedAsset(value: Asset) {
  return {
    ...value,
    labels: labels
      .filter((label) => membership[label.id]?.includes(value.id))
      .map((label) => ({
        ...label,
        position: membership[label.id].indexOf(value.id),
      })),
  };
}
function presentedLabel(value: Label) {
  const members = membership[value.id] ?? [];
  return {
    ...value,
    assetCount: members.length,
    assets: members.flatMap((id, position) => {
      const selected = assets.find((item) => item.id === id);
      return selected ? [{ position, asset: presentedAsset(selected) }] : [];
    }),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
function json(body: unknown, status = 200): Response {
  const wire = JSON.stringify(body);
  const response = new Response(wire, {
    status,
    headers: { "Content-Type": "application/json" },
  });
  // Fetch is the fixture boundary. Preserve the exact serialized response while
  // keeping its body delivery independent of Node stream timers in jsdom.
  response.json = async () => JSON.parse(wire);
  response.text = async () => wire;
  response.clone = () => json(JSON.parse(wire), status);
  return response;
}
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body =
    init?.body instanceof FormData
      ? init.body
      : init?.body
        ? JSON.parse(String(init.body))
        : undefined;
  requests.push({
    method,
    path: url.pathname + url.search,
    body,
    headers: new Headers(init?.headers),
  });
  if (gates[`${method} ${url.pathname}`])
    await gates[`${method} ${url.pathname}`];
  const configured = failures[`${method} ${url.pathname}`];
  const failure = typeof configured === "function" ? configured() : configured;
  if (failure instanceof Response) return failure.clone();
  if (failure !== undefined) throw failure;
  if (method === "GET" && url.pathname === "/media-assets") {
    const type = url.searchParams.get("mediaType");
    const search = url.searchParams.get("search")?.toLowerCase();
    const capability = url.searchParams.get("capability");
    let selected = assets.filter(
      (item) =>
        (!type || item.mediaType === type) &&
        (!search || item.name.toLowerCase().includes(search)) &&
        (!capability || item.capabilities.includes(capability)),
    );
    if (pageCount > 1)
      selected = selected.slice(
        Number(url.searchParams.get("page")) - 1,
        Number(url.searchParams.get("page")),
      );
    return json({
      data: selected.map(presentedAsset),
      meta: {
        total: pageCount > 1 ? 101 : selected.length,
        totalPages: pageCount,
      },
    });
  }
  if (url.pathname === "/media-labels" && method === "GET")
    return json({
      data: labels.map(presentedLabel),
      meta: { totalPages: labels.length ? 1 : 0 },
    });
  if (url.pathname.startsWith("/uploads/") && method === "POST") {
    const file = (body as FormData).get("file") as File;
    return json({
      key: file.name,
      url: `https://cdn.fixture.invalid/upload/${encodeURIComponent(file.name)}`,
      bucket: "fixture",
      contentType: file.type,
      sizeBytes: file.size,
    });
  }
  if (url.pathname === "/media" && method === "POST") {
    const id = ++assetSequence;
    const created = asset(`image:${id}`, body.name, {
      image: { id },
      sourceUrl: body.imageUrl,
    });
    assets.push(created);
    return json({
      id,
      assetId: created.id,
      name: created.name,
      imageUrl: created.sourceUrl,
    });
  }
  if (url.pathname === "/media-assets/background-audio" && method === "POST") {
    const created = asset(`background:${++assetSequence}`, body.name, {
      mediaType: "AUDIO",
      image: null,
      sourceUrl: body.sourceUrl,
      capabilities: ["BACKGROUND"],
      background: { defaultVolume: body.defaultVolume },
    });
    assets.push(created);
    return json(presentedAsset(created));
  }
  const imageRoute = url.pathname.match(/^\/media\/(\d+)$/);
  if (imageRoute && method === "PUT") {
    const selected = assets.find(
      (item) => item.image?.id === Number(imageRoute[1]),
    )!;
    Object.assign(selected, { name: body.name, sourceUrl: body.imageUrl });
    return json({
      id: selected.image!.id,
      assetId: selected.id,
      name: selected.name,
      imageUrl: selected.sourceUrl,
    });
  }
  const assignRoute = url.pathname.match(/^\/media-assets\/([^/]+)\/labels$/);
  if (assignRoute && method === "PUT") {
    const id = decodeURIComponent(assignRoute[1]);
    for (const label of labels) {
      membership[label.id] = (membership[label.id] ?? []).filter(
        (item) => item !== id,
      );
      if (body.labelIds.includes(label.id)) membership[label.id].push(id);
    }
    return json(presentedAsset(assets.find((item) => item.id === id)!));
  }
  if (url.pathname === "/media-labels" && method === "POST") {
    const created = {
      id: `label:${++assetSequence}`,
      name: body.name,
      description: body.description,
    };
    labels.push(created);
    membership[created.id] = [];
    return json(presentedLabel(created));
  }
  const labelRoute = url.pathname.match(/^\/media-labels\/([^/]+)(\/assets)?$/);
  if (labelRoute) {
    const id = decodeURIComponent(labelRoute[1]);
    const selected = labels.find((label) => label.id === id)!;
    if (method === "PUT" && labelRoute[2]) {
      membership[id] = body.assetIds;
      return json(presentedLabel(selected));
    }
    if (method === "PUT") {
      Object.assign(selected, body);
      return json(presentedLabel(selected));
    }
    if (method === "DELETE") {
      labels = labels.filter((label) => label.id !== id);
      delete membership[id];
      return json({ ok: true });
    }
  }
  const standaloneRoute = url.pathname.match(/^\/media-assets\/([^/]+)$/);
  if (method === "DELETE" && (imageRoute || standaloneRoute)) {
    const selected = imageRoute
      ? assets.find((item) => item.image?.id === Number(imageRoute[1]))
      : assets.find(
          (item) => item.id === decodeURIComponent(standaloneRoute![1]),
        );
    assets = assets.filter((item) => item.id !== selected!.id);
    for (const label of labels)
      membership[label.id] = membership[label.id].filter(
        (id) => id !== selected!.id,
      );
    return json({ ok: true });
  }
  unexpected.push(`${method} ${url.pathname}`);
  return json({ message: "Unexpected fixture route" }, 500);
}

const savedBrowser = ["showModal", "close"].map(
  (name) =>
    [
      name,
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
    ] as const,
);
const savedScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
const savedCapture = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "hasPointerCapture",
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
beforeAll(() => {
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
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  vi.stubGlobal("PointerEvent", BrowserPointerEvent);
});
beforeEach(() => {
  assets = [
    asset("image:1", "Sunset"),
    asset("image:2", "City"),
    asset("background:3", "Weather bed", {
      mediaType: "AUDIO",
      image: null,
      capabilities: ["BACKGROUND"],
      background: { defaultVolume: 0.5 },
    }),
    asset("video:4", "Opening video", {
      mediaType: "VIDEO",
      image: null,
      capabilities: ["TRANSITION"],
      transition: { id: 4, cutPointMs: 500 },
    }),
  ];
  labels = [
    {
      id: "label:news",
      name: "News",
      description: "Opening editorial selection",
    },
    { id: "label:weather", name: "Weather", description: null },
  ];
  membership = {
    "label:news": ["image:1", "background:3"],
    "label:weather": ["image:2"],
  };
  requests = [];
  failures = {};
  gates = {};
  unexpected = [];
  pageCount = 1;
  assetSequence = 20;
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  // Alert cleanup does not need an accessibility-tree scan of a closing portal.
  const alerts = [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Close alert"]',
    ),
  ];
  startMediaClock();
  try {
    act(() => {
      for (const button of alerts) fireEvent.click(button);
      vi.advanceTimersByTime(220);
      cleanup();
      vi.advanceTimersByTime(750);
    });
  } finally {
    vi.useRealTimers();
  }
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const [name, descriptor] of savedBrowser) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  for (const [name, descriptor] of [
    ["scrollIntoView", savedScroll],
    ["hasPointerCapture", savedCapture],
  ] as const) {
    if (descriptor)
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  vi.unstubAllGlobals();
});

function Context({ programType }: { programType: ProgramType | null }) {
  const location = useLocation();
  return (
    <>
      <output data-testid="media-location">
        {location.pathname}
        {location.search}
      </output>
      <Outlet context={{ programType }} />
    </>
  );
}
function mount(
  path = "/media?type=IMAGE",
  programType: ProgramType | null = "tv",
) {
  const tree = () => (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Context programType={programType} />}>
          <Route path="media" element={<MediaRoute />} />
          <Route path="*" element={<p>Destination route</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return render(tree());
}
async function ready(path?: string, programType?: ProgramType | null) {
  const view = mount(path, programType);
  await screen.findByText("Media library");
  await waitFor(() =>
    expect(
      requests.some((request) => request.path.startsWith("/media-assets")),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(view.container.querySelector(".animate-spin")).toBeNull(),
  );
  return view;
}
function writes(method: string, path: string) {
  return requests.filter(
    (request) =>
      request.method === method && request.path.split("?")[0] === path,
  );
}
async function dialog(name: string) {
  return screen.findByRole("dialog", { name });
}
async function imageDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  return dialog("Add images");
}
function input(container: HTMLElement, placeholder: string, value: string) {
  fireEvent.change(within(container).getByPlaceholderText(placeholder), {
    target: { value },
  });
}
function chooseFiles(container: HTMLElement, files: File[]) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files },
  });
}
async function alert(message: string | RegExp) {
  expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
}

function startMediaClock() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
}

async function selectedNews() {
  await ready("/media?view=labels");
  fireEvent.click(
    await screen.findByRole("button", { name: /News.*2 assets/ }),
  );
  await screen.findByRole("heading", { name: "News" });
}

export const mediaState = {
  get assets() {
    return assets;
  },
  set assets(value: Asset[]) {
    assets = value;
  },
  get labels() {
    return labels;
  },
  set labels(value: Label[]) {
    labels = value;
  },
  get membership() {
    return membership;
  },
  set membership(value: Record<string, string[]>) {
    membership = value;
  },
  get requests() {
    return requests;
  },
  set requests(value: Request[]) {
    requests = value;
  },
  get failures() {
    return failures;
  },
  set failures(value: Record<string, Failure>) {
    failures = value;
  },
  get pageCount() {
    return pageCount;
  },
  set pageCount(value: number) {
    pageCount = value;
  },
  get gates() {
    return gates;
  },
  set gates(value: Partial<Record<string, Promise<void>>>) {
    gates = value;
  },
};
export {
  asset,
  ready,
  mount,
  writes,
  dialog,
  imageDialog,
  input,
  chooseFiles,
  alert,
  selectedNews,
  json,
  startMediaClock,
};
