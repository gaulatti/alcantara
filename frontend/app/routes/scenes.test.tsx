import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ScenesAdmin, { meta } from "./scenes";
import { routeFetch } from "../../test/routeKit";
import {
  cancelConfirmation,
  chooseFromRowMenu,
  confirmWith,
  confirmation,
} from "../../test/libraryKit";

vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  const { libraryBleecker } = await import("../../test/libraryKit");
  return kit.nativeSelect(
    () =>
      libraryBleecker(
        original as () => Promise<typeof import("@gaulatti/bleecker")>,
      ) as Promise<typeof import("@gaulatti/bleecker")>,
  );
});

const LAYOUTS = [
  { id: 1, name: "Full screen" },
  { id: 2, name: "Split" },
];
let scenes: {
  id: number;
  name: string;
  layoutId: number;
  layout: { id: number; name: string } | null;
}[];

function serve(overrides: Partial<Record<string, () => Response>> = {}) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${new URL(url).pathname}`;
    if (overrides[key]) return overrides[key]!();
    if (key === "GET /scenes") return Response.json(scenes);
    if (key === "GET /layouts") return Response.json(LAYOUTS);
    if (key === "POST /scenes") {
      const body = JSON.parse(String(init!.body));
      scenes = [
        ...scenes,
        {
          id: 9,
          ...body,
          layout: LAYOUTS.find((l) => l.id === body.layoutId)!,
        },
      ];
      return Response.json(scenes.at(-1));
    }
    if (method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse(String(init!.body));
      scenes = scenes.map((scene) =>
        scene.id === id ? { ...scene, ...body } : scene,
      );
      return Response.json({});
    }
    if (method === "DELETE") {
      const id = Number(url.split("/").pop());
      scenes = scenes.filter((scene) => scene.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${key}`);
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/scenes"]}>
      <Routes>
        <Route path="/scenes" element={<ScenesAdmin />} />
        <Route path="/layouts" element={<p>Scene templates page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  scenes = [
    { id: 1, name: "Morning headlines", layoutId: 1, layout: LAYOUTS[0] },
    { id: 2, name: "Afternoon", layoutId: 2, layout: null },
  ];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("has a page title and description", () => {
  expect(meta({} as never)).toEqual([
    { title: "Scenes - TV Broadcast" },
    { name: "description", content: "Create, edit, and delete scenes" },
  ]);
});

it("lists scenes with their template, sortable by name", async () => {
  serve();
  renderPage();
  const morning = await screen.findByText("Morning headlines");
  const rows = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent);
  expect(rows()[0]).toMatch(/^Afternoon#2/);
  expect(rows()[1]).toMatch(/^Morning headlinesFull screen/);
  expect(morning).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Name/ }));
  expect(rows()[0]).toMatch(/^Morning headlines/);
});

it("shows loading until the scenes arrive", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/layouts")) return Response.json(LAYOUTS);
      await gate;
      return Response.json(scenes);
    }),
  );
  renderPage();
  expect(await screen.findByLabelText("Loading Scenes")).toBeVisible();
  release();
  expect(await screen.findByText("Morning headlines")).toBeVisible();
});

it("asks for a layout first and links to the templates", async () => {
  serve({ "GET /layouts": () => Response.json([]) });
  renderPage();
  expect(await screen.findByText("Create a layout first")).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: /Create Scene/ })[0],
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Go to scene templates" }),
  );
  expect(await screen.findByText("Scene templates page")).toBeVisible();
});

it("explains a load failure with a retry", async () => {
  serve({ "GET /scenes": () => new Response(null, { status: 500 }) });
  renderPage();
  expect(await screen.findByText("Failed to load scenes")).toBeVisible();
  expect(screen.queryByText("Create a layout first")).not.toBeInTheDocument();
  serve();
  fireEvent.click(screen.getByText("Retry").closest("button")!);
  expect(await screen.findByText("Morning headlines")).toBeVisible();
});

it("explains a layout load failure", async () => {
  serve({ "GET /layouts": () => new Response(null, { status: 503 }) });
  renderPage();
  expect(await screen.findByText("Failed to load scenes")).toBeVisible();
});

it("offers to create the first scene", async () => {
  scenes = [];
  serve();
  renderPage();
  expect(await screen.findByText("No scenes yet")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Create Scene" })[1]);
  expect(within(dialog()).getByRole("combobox")).toHaveValue("1");
});

it("creates a scene, requiring a name and a layout", async () => {
  const calls = serve();
  renderPage();
  await screen.findByText("Morning headlines");
  fireEvent.click(screen.getAllByRole("button", { name: /Create Scene/ })[0]);
  const name = within(dialog()).getByPlaceholderText("Morning Headlines");
  const layout = within(dialog()).getByRole("combobox");
  expect(layout).toHaveValue("1");

  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Create Scene" }),
  );
  expect(within(dialog()).getByText("Scene name is required.")).toBeVisible();
  fireEvent.change(name, { target: { value: "  Evening news " } });
  expect(
    within(dialog()).queryByText("Scene name is required."),
  ).not.toBeInTheDocument();

  fireEvent.change(layout, { target: { value: "" } });
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Create Scene" }),
  );
  expect(within(dialog()).getByText("Select a layout.")).toBeVisible();
  fireEvent.change(layout, { target: { value: "2" } });
  expect(
    within(dialog()).queryByText("Select a layout."),
  ).not.toBeInTheDocument();
  // Typing with no error showing leaves it clear.
  fireEvent.change(name, { target: { value: "Evening news" } });
  fireEvent.change(layout, { target: { value: "2" } });

  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Create Scene" }),
  );
  expect((await screen.findAllByText("Scene created."))[0]).toBeVisible();
  const post = calls.find((call) => call.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    name: "Evening news",
    layoutId: 2,
  });
  expect(await screen.findByText("Evening news")).toBeVisible();
});

it("edits a scene and reports a refused save", async () => {
  const calls = serve();
  renderPage();
  await screen.findByText("Morning headlines");
  fireEvent.click(
    screen.getByRole("button", { name: "Edit Morning headlines" }),
  );
  expect(
    screen.getByRole("heading", { name: "Edit Scene" }),
  ).toBeInTheDocument();
  const name = within(dialog()).getByPlaceholderText("Morning Headlines");
  expect(name).toHaveValue("Morning headlines");
  fireEvent.change(name, { target: { value: "Morning briefing" } });
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Update Scene" }),
  );
  expect((await screen.findAllByText("Scene updated."))[0]).toBeVisible();
  expect(
    calls.some(
      (call) => call.init?.method === "PUT" && call.url.endsWith("/scenes/1"),
    ),
  ).toBe(true);
  expect(await screen.findByText("Morning briefing")).toBeVisible();

  serve({ "PUT /scenes/2": () => new Response("Name taken", { status: 409 }) });
  fireEvent.click(screen.getByRole("button", { name: "Edit Afternoon" }));
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Update Scene" }),
  );
  expect(
    await within(dialog()).findByText("Failed to save scene."),
  ).toBeVisible();
  fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
});

it("reports a save that fails without a message", async () => {
  serve({ "POST /scenes": () => new Response("", { status: 500 }) });
  renderPage();
  await screen.findByText("Morning headlines");
  fireEvent.click(screen.getAllByRole("button", { name: /Create Scene/ })[0]);
  fireEvent.change(within(dialog()).getByPlaceholderText("Morning Headlines"), {
    target: { value: "Late" },
  });
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Create Scene" }),
  );
  expect(
    await within(dialog()).findByText("Failed to save scene."),
  ).toBeVisible();
});

it("deletes a scene only after confirmation, and reports a failure", async () => {
  serve();
  renderPage();
  await screen.findByText("Morning headlines");
  await chooseFromRowMenu("Afternoon", "Delete");
  expect(
    within(await confirmation()).getByText('Delete scene "Afternoon"?'),
  ).toBeVisible();
  await cancelConfirmation();
  expect(screen.getByText("Afternoon")).toBeVisible();

  await chooseFromRowMenu("Afternoon", "Delete");
  await confirmWith("Delete");
  expect((await screen.findAllByText("Scene deleted."))[0]).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByText("Afternoon")).not.toBeInTheDocument(),
  );

  serve({ "DELETE /scenes/1": () => new Response("In use", { status: 409 }) });
  await chooseFromRowMenu("Morning headlines", "Delete");
  await confirmWith("Delete");
  expect(
    (await screen.findAllByText("Failed to delete scene."))[0],
  ).toBeVisible();

  serve({ "DELETE /scenes/1": () => new Response("", { status: 500 }) });
  await chooseFromRowMenu("Morning headlines", "Delete");
  await confirmWith("Delete");
  await waitFor(() =>
    expect(
      screen.getAllByText("Failed to delete scene.").length,
    ).toBeGreaterThan(0),
  );
});
