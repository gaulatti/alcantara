import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RadioSettingsRoute, { meta } from "./radio-settings";
import { routeFetch } from "../../test/routeKit";

// Radio distribution settings: automation, bumpers and now-playing consumers.
// The recovery playlist and song similarity panels belong to
// gaulatti/alcantara#184, so they are stand-ins here.

vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["night radio"],
}));
vi.mock("../components/RecoveryPlaylistPanel", () => ({
  RecoveryPlaylistPanel: ({ programId }: { programId: string }) => (
    <p>Recovery playlist for {programId}</p>
  ),
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({
    hasPermission: (permission: string) => permission === "broadcast.manage",
  }),
}));
// gaulatti/alcantara#20: the radio's filler is configured from its own settings page.
vi.mock("../components/ProgramFillerPanel", () => ({
  ProgramFillerPanel: (props: {
    programId: string;
    canManage: boolean;
    only?: string;
  }) => (
    <p>
      Filler for {props.programId}, {props.only} leg,{" "}
      {props.canManage ? "may manage" : "read only"}
    </p>
  ),
}));
vi.mock("../components/SongSimilarityPanel", () => ({
  SongSimilarityPanel: ({ programId }: { programId: string }) => (
    <p>Song similarity for {programId}</p>
  ),
}));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

type Settings = {
  palazzoUrl: string;
  bumperEnabled: boolean;
  bumperInterval: number | null;
  bumperInstantIds: number[];
  bumperMode: string | null;
  enabled: boolean;
};

let settings: Settings;
let consumers: unknown;
let instants: unknown;
let publishing: unknown = { publishing: "enabled" };

function serve(overrides: Partial<Record<string, () => Response>> = {}) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(new URL(url).pathname);
    const key = `${method} ${path}`;
    if (overrides[key]) return overrides[key]!();
    if (key === "GET /radio/night radio/settings")
      return Response.json(settings);
    if (key === "GET /radio/night radio/now-playing-consumers")
      return Response.json(consumers);
    if (key === "GET /instants") return Response.json(instants);
    if (key === "GET /radio/night radio/now-playing-publishing")
      return Response.json(publishing);
    if (key === "PUT /radio/night radio/settings") {
      settings = JSON.parse(String(init!.body));
      return Response.json(settings);
    }
    if (key === "PUT /radio/night radio/now-playing-consumers") {
      const body = JSON.parse(String(init!.body)) as { consumers: unknown[] };
      return Response.json(
        body.consumers.map((consumer, index) => ({
          id: index + 1,
          ...(consumer as object),
        })),
      );
    }
    throw new Error(`unexpected ${key}`);
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return calls;
}

const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeVisible();
const bodyOf = (
  calls: { url: string; init: RequestInit | undefined }[],
  method: string,
  suffix: string,
) =>
  JSON.parse(
    String(
      calls.find(
        (call) => call.init?.method === method && call.url.endsWith(suffix),
      )!.init!.body,
    ),
  );

beforeEach(() => {
  publishing = { publishing: "enabled" };
  settings = {
    palazzoUrl: "http://palazzo:3100",
    bumperEnabled: true,
    bumperInterval: null,
    bumperInstantIds: [5],
    bumperMode: null,
    enabled: true,
  };
  consumers = [
    {
      id: 1,
      name: "Website",
      url: "https://hooks.example/now",
      method: "PUT",
      headers: { "X-Token": "fictional", Count: 3 },
      enabled: false,
    },
    { headers: ["not", "an", "object"] },
  ];
  instants = [
    { id: 5, name: "Station ID", enabled: true },
    { id: 6, name: "Jingle", enabled: true },
    { id: 7, name: "Retired sweep", enabled: false },
  ];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("has a page title and description", () => {
  expect(meta({} as never)).toEqual([
    { title: "Radio distribution - Alcántara" },
    {
      name: "description",
      content: "Configure radio automation and now-playing delivery",
    },
  ]);
});

it("loads the station's settings, enabled clips and normalized consumers", async () => {
  serve();
  render(<RadioSettingsRoute />);
  expect(
    await screen.findByText("Recovery playlist for night radio"),
  ).toBeVisible();
  expect(screen.getByText("Song similarity for night radio")).toBeVisible();
  expect(screen.getByDisplayValue("http://palazzo:3100")).toBeVisible();
  // Missing order and interval show their defaults.
  expect(screen.getByDisplayValue("Sequential")).toBeVisible();
  expect(screen.getByDisplayValue("4")).toBeVisible();
  expect(screen.getByLabelText("Station ID")).toBeChecked();
  expect(screen.getByLabelText("Jingle")).not.toBeChecked();
  expect(screen.queryByLabelText("Retired sweep")).not.toBeInTheDocument();

  expect(screen.getByDisplayValue("Website")).toBeVisible();
  expect(screen.getByDisplayValue("https://hooks.example/now")).toBeVisible();
  expect(screen.getByDisplayValue("X-Token")).toBeVisible();
  expect(screen.getByDisplayValue("3")).toBeVisible();
  // A consumer with malformed fields is shown with safe defaults.
  expect(
    screen.getByRole("button", { name: "Remove consumer 2" }),
  ).toBeVisible();
});

it.each([
  ["GET /radio/night radio/settings", "Radio settings failed (500)"],
  [
    "GET /radio/night radio/now-playing-consumers",
    "Now-playing delivery failed (500)",
  ],
  ["GET /instants", "Audio clips failed (500)"],
  [
    "GET /radio/night radio/now-playing-publishing",
    "Now-playing publishing state failed (500)",
  ],
])(
  "explains a configuration that cannot be read (%s) and retries",
  async (route, message) => {
    serve({ [route]: () => new Response(null, { status: 500 }) });
    render(<RadioSettingsRoute />);
    await toast(message);
    expect(screen.getByText("Radio configuration unavailable")).toBeVisible();
    serve();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByDisplayValue("http://palazzo:3100"),
    ).toBeVisible();
  },
);

it("explains a failure that is not an error object", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
  render(<RadioSettingsRoute />);
  await toast("Radio configuration could not be loaded.");
});

it("tolerates payloads that are not lists", async () => {
  consumers = { not: "a list" };
  instants = null;
  serve();
  render(<RadioSettingsRoute />);
  expect(await screen.findByText("No consumers configured")).toBeVisible();
  expect(screen.queryByLabelText("Station ID")).not.toBeInTheDocument();
});

it("saves automation and bumper settings", async () => {
  const calls = serve();
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("http://palazzo:3100");
  fireEvent.click(screen.getByLabelText("Enable Alcántara radio automation"));
  fireEvent.change(screen.getByDisplayValue("http://palazzo:3100"), {
    target: { value: "http://palazzo-2:3100" },
  });
  fireEvent.change(screen.getByDisplayValue("Sequential"), {
    target: { value: "random" },
  });
  fireEvent.change(screen.getByDisplayValue("4"), { target: { value: "6" } });
  fireEvent.click(screen.getByLabelText("Jingle"));
  fireEvent.click(screen.getByLabelText("Station ID"));
  fireEvent.click(screen.getByRole("button", { name: /Save radio settings/ }));
  await toast("Radio distribution settings saved.");
  expect(bodyOf(calls, "PUT", "/settings")).toEqual({
    palazzoUrl: "http://palazzo-2:3100",
    bumperEnabled: true,
    bumperInterval: 6,
    bumperInstantIds: [6],
    bumperMode: "random",
    enabled: false,
  });
});

it("clears the interval when it is not a number, and hides bumpers when they are off", async () => {
  const calls = serve();
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("http://palazzo:3100");
  fireEvent.change(screen.getByDisplayValue("4"), { target: { value: "" } });
  fireEvent.click(screen.getByLabelText("Insert station IDs and bumpers"));
  expect(screen.queryByText("Eligible audio clips")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Save radio settings/ }));
  await waitFor(() =>
    expect(bodyOf(calls, "PUT", "/settings")).toMatchObject({
      bumperEnabled: false,
      bumperInterval: null,
    }),
  );
});

it.each([
  [new Response(null, { status: 409 }), "Radio settings were not saved (409)"],
  [
    Response.json({ message: "bumperMode must be sequential or random" }, { status: 400 }),
    "Radio settings were not saved (400): bumperMode must be sequential or random",
  ],
  ["offline", "Radio settings were not saved."],
])(
  "reports settings that could not be saved (%s)",
  async (failure, message) => {
    serve({
      "PUT /radio/night radio/settings": () => {
        if (failure instanceof Response) return failure;
        throw failure;
      },
    });
    render(<RadioSettingsRoute />);
    await screen.findByDisplayValue("http://palazzo:3100");
    fireEvent.click(
      screen.getByRole("button", { name: /Save radio settings/ }),
    );
    await toast(message);
  },
);

it("edits, adds and removes consumers and their headers, then saves them", async () => {
  const calls = serve();
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("Website");
  fireEvent.click(screen.getByRole("button", { name: "Remove consumer 2" }));
  fireEvent.click(screen.getByRole("button", { name: /Add consumer/ }));
  expect(screen.getByDisplayValue("consumer-2")).toBeVisible();

  fireEvent.change(screen.getByDisplayValue("Website"), {
    target: { value: "Site" },
  });
  fireEvent.change(screen.getByDisplayValue("https://hooks.example/now"), {
    target: { value: " https://hooks.example/v2 " },
  });
  fireEvent.change(screen.getByDisplayValue("PUT"), {
    target: { value: "PATCH" },
  });
  fireEvent.click(screen.getAllByLabelText("Enabled")[0]);
  // Rename one header, change the other's value, then remove it.
  fireEvent.change(screen.getByDisplayValue("X-Token"), {
    target: { value: " Authorization " },
  });
  fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "4" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Remove header" })[1]);
  // A blank header on the new consumer is dropped on save.
  fireEvent.click(screen.getAllByRole("button", { name: /Add header/ })[1]);

  fireEvent.click(screen.getByRole("button", { name: /Save consumers/ }));
  await toast("Now-playing delivery saved.");
  expect(bodyOf(calls, "PUT", "/now-playing-consumers")).toEqual({
    consumers: [
      {
        name: "Site",
        url: "https://hooks.example/v2",
        method: "PATCH",
        headers: { Authorization: "fictional" },
        enabled: true,
      },
      {
        name: "consumer-2",
        url: "",
        method: "POST",
        headers: {},
        enabled: true,
      },
    ],
  });
  // The server's answer replaces the list.
  expect(screen.getByRole("button", { name: "Remove Site" })).toBeVisible();
});

it("removes a consumer named only by its position", async () => {
  consumers = [
    { name: "", url: "", method: "POST", headers: {}, enabled: true },
  ];
  serve();
  render(<RadioSettingsRoute />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove consumer 1" }),
  );
  expect(screen.getByText("No consumers configured")).toBeVisible();
});

it("refuses a header value without a name", async () => {
  const calls = serve();
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("Website");
  fireEvent.change(screen.getByDisplayValue("X-Token"), {
    target: { value: "  " },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save consumers/ }));
  await toast("Consumer 1: header name is required");
  expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
});

it.each([
  [
    () => new Response(null, { status: 422 }),
    "Now-playing delivery was not saved (422)",
  ],
  [() => Response.json({ not: "a list" }), "Now-playing delivery saved."],
  [
    () =>
      Response.json(
        {
          statusCode: 400,
          error: "Bad Request",
          message: "Consumer 1: the URL must use https.",
        },
        { status: 400 },
      ),
    "Now-playing delivery was not saved: Consumer 1: the URL must use https.",
  ],
  [
    () => Response.json({ message: ["not", "a string"] }, { status: 400 }),
    "Now-playing delivery was not saved (400)",
  ],
  [
    () => Response.json({ message: "   " }, { status: 400 }),
    "Now-playing delivery was not saved (400)",
  ],
  [
    () => new Response("not json", { status: 400 }),
    "Now-playing delivery was not saved (400)",
  ],
])("reports the consumer save result (%#)", async (answer, message) => {
  serve({ "PUT /radio/night radio/now-playing-consumers": answer });
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("Website");
  fireEvent.click(screen.getByRole("button", { name: /Save consumers/ }));
  await toast(message);
});

it("reports a consumer save that fails without an error object", async () => {
  serve({
    "PUT /radio/night radio/now-playing-consumers": () => {
      throw "offline";
    },
  });
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("Website");
  fireEvent.click(screen.getByRole("button", { name: /Save consumers/ }));
  await toast("Now-playing delivery was not saved.");
});

it("says no now-playing consumer is contacted on a local stack (gaulatti/alcantara#206)", async () => {
  publishing = { publishing: "blocked-local" };
  serve();
  render(<RadioSettingsRoute />);
  expect(
    await screen.findByText(
      "Publishing is off on this local stack: no consumer is contacted outside production.",
    ),
  ).toBeVisible();
});

it("shows no local-stack notice where publishing is enabled", async () => {
  serve();
  render(<RadioSettingsRoute />);
  expect(await screen.findByText("Now-playing consumers")).toBeVisible();
  expect(
    screen.queryByText(/Publishing is off on this local stack/),
  ).not.toBeInTheDocument();
});

it("shows the set-up form with a notice when the show has no radio settings yet", async () => {
  serve({ "GET /radio/night radio/settings": () => Response.json(null) });
  render(<RadioSettingsRoute />);
  expect(await screen.findByText("Radio isn't set up yet")).toBeVisible();
  expect(screen.queryByText("The selected show does not expose a radio configuration.")).toBeNull();
  expect(screen.getByRole("button", { name: /Save radio settings/ })).toBeVisible();
  // Nothing that works on saved settings stands between the notice and the form that creates them.
  expect(screen.queryByText("Song similarity for night radio")).toBeNull();
  // The recovery panel is mocked here under this text.
  expect(screen.queryByText("Recovery playlist for night radio")).toBeNull();
});

it("creates the radio settings on the first save, and drops the notice once they exist", async () => {
  const calls = serve({ "GET /radio/night radio/settings": () => Response.json(null) });
  render(<RadioSettingsRoute />);
  await screen.findByText("Radio isn't set up yet");
  fireEvent.change(screen.getByLabelText("Palazzo control URL"), { target: { value: "http://palazzo:3100" } });
  fireEvent.click(screen.getByRole("button", { name: /Save radio settings/ }));
  await toast("Radio distribution settings saved.");
  expect(bodyOf(calls, "PUT", "/settings")).toEqual({
    palazzoUrl: "http://palazzo:3100",
    bumperEnabled: false,
    bumperInterval: null,
    bumperInstantIds: [],
    bumperMode: null,
    enabled: false,
  });
  expect(screen.queryByText("Radio isn't set up yet")).toBeNull();
  // Once they exist, what works on saved settings is offered.
  expect(screen.getByText("Recovery playlist for night radio")).toBeVisible();
  expect(screen.getByText("Song similarity for night radio")).toBeVisible();
});

it("confirms a saved radio settings on the form, beside the Save button", async () => {
  serve();
  render(<RadioSettingsRoute />);
  await screen.findByDisplayValue("http://palazzo:3100");
  expect(screen.queryByText("Radio settings saved.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Save radio settings/ }));
  expect(await screen.findByText("Radio settings saved.")).toBeVisible();
});

it("shows the radio filler beside the recovery playlist once the radio is set up", async () => {
  serve();
  render(<RadioSettingsRoute />);
  expect(
    await screen.findByText(
      "Filler for night radio, radio leg, may manage",
    ),
  ).toBeInTheDocument();
});
