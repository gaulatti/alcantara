import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LayoutsAdmin, { meta } from "./layouts";
import { routeFetch } from "../../test/routeKit";

// A short component catalog keeps the dialog small; the route lists whatever
// the catalog holds.
vi.mock("../models/components", () => ({
  OVERLAY_COMPONENTS: [
    {
      id: "ticker",
      name: "Ticker",
      description: "Bottom ticker bar with hashtag and URL",
    },
    { id: "chyron", name: "Chyron", description: "Animated message overlay" },
    { id: "clock-widget", name: "Clock", description: "Live time widget" },
  ],
}));

type Layout = {
  id: number;
  name: string;
  componentType: string;
  settings: string;
};
let layouts: Layout[];

function serve(overrides: Partial<Record<string, () => Response>> = {}) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${new URL(url).pathname}`;
    if (overrides[key]) return overrides[key]!();
    if (key === "GET /layouts") return Response.json(layouts);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (key === "POST /layouts") {
      layouts = [
        ...layouts,
        {
          id: 9,
          name: body.name,
          componentType: body.componentType,
          settings: "{}",
        },
      ];
      return Response.json({});
    }
    const id = Number(url.split("/").pop());
    if (method === "PUT") {
      layouts = layouts.map((layout) =>
        layout.id === id
          ? { ...layout, name: body.name, componentType: body.componentType }
          : layout,
      );
      return Response.json({});
    }
    if (method === "DELETE") {
      layouts = layouts.filter((layout) => layout.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${key}`);
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return calls;
}

// The template dialog lists every overlay component, so role queries over it
// are slow; these find its controls by their visible text instead.
// Bleecker renders its modal as a div with role="dialog"; a plain selector
// keeps lookups inside the large template and clip forms fast.
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const dialogButton = (text: string) =>
  within(dialog())
    .getAllByText(text)
    .map((element) => element.closest("button"))
    .find(Boolean) as HTMLButtonElement;
const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeVisible();
const componentButton = (name: string) =>
  within(dialog())
    .getByText(name, { selector: "p" })
    .closest("button") as HTMLElement;
const checkboxOf = (name: string) =>
  componentButton(name).querySelector('input[type="checkbox"]') as HTMLElement;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  layouts = [
    {
      id: 1,
      name: "News desk",
      componentType: "ticker,chyron",
      settings: "{}",
    },
    {
      id: 2,
      name: "Archive",
      componentType: "retired-widget,",
      settings: "{}",
    },
  ];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("has a page title and description", () => {
  expect(meta({} as never)).toEqual([
    { title: "Scene templates - Alcantara" },
    { name: "description", content: "Manage reusable scene templates" },
  ]);
});

it("lists templates by name with their components", async () => {
  serve();
  render(<LayoutsAdmin />);
  expect(screen.getByText("Loading scene templates...")).toBeVisible();
  const news = (await screen.findByText("News desk")).closest("tr")!;
  expect(within(news).getByText("Ticker")).toHaveAttribute(
    "title",
    "Bottom ticker bar with hashtag and URL",
  );
  expect(within(news).getByText("Chyron")).toBeVisible();
  // A component the catalog no longer has shows its stored id.
  const archive = screen.getByText("Archive").closest("tr")!;
  expect(within(archive).getByText("retired-widget")).toBeVisible();

  const rows = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent);
  expect(rows()[0]).toMatch(/^Archive/);
  fireEvent.click(screen.getByText("Name").closest("button")!);
  expect(rows()[0]).toMatch(/^News desk/);
});

it("explains a load failure", async () => {
  serve({ "GET /layouts": () => new Response(null, { status: 500 }) });
  render(<LayoutsAdmin />);
  await toast("Failed to load scene templates. Please refresh and try again.");
});

it("creates a template, requiring a name and at least one component", async () => {
  layouts = [];
  const calls = serve();
  render(<LayoutsAdmin />);
  fireEvent.click(
    (await screen.findByText("Create your first template")).closest("button")!,
  );
  expect(within(dialog()).getByRole("heading")).toHaveTextContent(
    "Create template",
  );

  fireEvent.click(dialogButton("Create template"));
  expect(
    within(dialog()).getByText("Please enter a template name"),
  ).toBeVisible();
  expect(
    within(dialog()).getByText("Please select at least one component"),
  ).toBeVisible();

  fireEvent.change(
    within(dialog()).getByPlaceholderText("Enter template name"),
    {
      target: { value: "Evening" },
    },
  );
  expect(
    within(dialog()).queryByText("Please enter a template name"),
  ).not.toBeInTheDocument();
  fireEvent.click(componentButton("Ticker"));
  expect(
    within(dialog()).queryByText("Please select at least one component"),
  ).not.toBeInTheDocument();
  expect(within(dialog()).getByText("Selected: 1 component")).toBeVisible();
  // The checkbox toggles too, without also toggling its button.
  fireEvent.click(checkboxOf("Chyron"));
  expect(within(dialog()).getByText("Selected: 2 components")).toBeVisible();
  fireEvent.click(componentButton("Chyron"));
  expect(within(dialog()).getByText("Selected: 1 component")).toBeVisible();
  // Typing again with no error leaves the form clean.
  fireEvent.change(
    within(dialog()).getByPlaceholderText("Enter template name"),
    {
      target: { value: "Evening news" },
    },
  );

  fireEvent.click(dialogButton("Create template"));
  await toast("Scene template created.");
  const post = calls.find((call) => call.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    name: "Evening news",
    componentType: "ticker",
    settings: { components: ["ticker"] },
  });
  expect(await screen.findByText("Evening news")).toBeVisible();
});

it("clears a component error from the checkbox as well", async () => {
  serve();
  render(<LayoutsAdmin />);
  await screen.findByText("News desk");
  fireEvent.click(screen.getAllByText("Create template")[0].closest("button")!);
  fireEvent.click(dialogButton("Create template"));
  expect(
    within(dialog()).getByText("Please select at least one component"),
  ).toBeVisible();
  fireEvent.click(checkboxOf("Ticker"));
  expect(
    within(dialog()).queryByText("Please select at least one component"),
  ).not.toBeInTheDocument();
  fireEvent.click(dialogButton("Cancel"));
});

it("edits a template and reports a refused save", async () => {
  const calls = serve();
  render(<LayoutsAdmin />);
  await screen.findByText("News desk");
  fireEvent.click(screen.getByLabelText("Edit News desk"));
  expect(within(dialog()).getByRole("heading")).toHaveTextContent(
    "Edit scene template",
  );
  expect(within(dialog()).getByText("Selected: 2 components")).toBeVisible();
  fireEvent.click(componentButton("Chyron"));
  fireEvent.click(dialogButton("Update template"));
  await toast("Scene template updated.");
  const put = calls.find((call) => call.init?.method === "PUT")!;
  expect(put.url).toMatch(/\/layouts\/1$/);
  expect(JSON.parse(String(put.init!.body)).componentType).toBe("ticker");

  serve({ "PUT /layouts/2": () => new Response("Locked", { status: 409 }) });
  fireEvent.click(screen.getByLabelText("Edit Archive"));
  fireEvent.click(dialogButton("Update template"));
  expect(
    await within(dialog()).findByText(
      "Failed to save scene template. Please try again.",
    ),
  ).toBeVisible();
});

it("reports a save that fails without a message", async () => {
  serve({ "POST /layouts": () => new Response("", { status: 500 }) });
  render(<LayoutsAdmin />);
  await screen.findByText("News desk");
  fireEvent.click(screen.getAllByText("Create template")[0].closest("button")!);
  fireEvent.change(
    within(dialog()).getByPlaceholderText("Enter template name"),
    {
      target: { value: "Late" },
    },
  );
  fireEvent.click(componentButton("Ticker"));
  fireEvent.click(dialogButton("Create template"));
  expect(
    await within(dialog()).findByText(
      "Failed to save scene template. Please try again.",
    ),
  ).toBeVisible();
});

it("deletes a template only after confirmation, and explains a template in use", async () => {
  serve();
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  render(<LayoutsAdmin />);
  await screen.findByText("Archive");
  fireEvent.click(screen.getByLabelText("Delete Archive"));
  expect(screen.getByText("Archive")).toBeVisible();
  fireEvent.click(screen.getByLabelText("Delete Archive"));
  await toast("Scene template deleted.");
  await waitFor(() =>
    expect(screen.queryByText("Archive")).not.toBeInTheDocument(),
  );

  serve({ "DELETE /layouts/1": () => new Response(null, { status: 409 }) });
  vi.stubGlobal("confirm", () => true);
  fireEvent.click(screen.getByLabelText("Delete News desk"));
  await toast(
    "Cannot delete this scene template because it may be in use by scenes.",
  );
});
