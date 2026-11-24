import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RecipeEditor, { RECIPE_STEPS } from "./RecipeEditor";
import type { FlightCue, FlightSequence } from "../models/broadcast";

// gaulatti/alcantara#465: deleting a recipe from the Recipes tab. Bleecker's RowActions has its own
// tests for the menu and its confirmation; here a stand-in shows the confirmation text and runs the item.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    RowActions: ({ items, label }: any) => (
      <div>
        {items.map((item: any) => (
          <button
            key={item.label}
            type="button"
            data-confirm={item.confirm}
            onClick={item.onSelect}
          >
            {`${item.label} ${label}`}
          </button>
        ))}
      </div>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const recipe = (id: number, name: string) => ({
  id,
  name,
  revision: 3,
  steps: RECIPE_STEPS.map((step) => step.key),
  returnSceneId: null,
  bumperSceneId: null,
  slideshowSceneId: null,
  transitionId: "cut",
  holdMs: 0,
});
const use = (useId: string, recipeId: number) =>
  ({
    id: `${useId}.song`,
    kind: "playSong",
    recipeUse: { useId, recipeId, step: "song" },
  }) as unknown as FlightCue;
const sequence = (isRunning: boolean): FlightSequence =>
  ({
    id: 12,
    name: "e2e",
    items: [use("use_a", 1), use("use_b", 1)],
    loop: false,
    isRunning,
    activeItemId: null,
    scheduledAt: null,
    publishedAt: null,
    revision: 1,
    lastStartedAt: null,
    createdAt: "",
    updatedAt: "",
  }) as FlightSequence;

function stubApi(options: { running?: boolean; remove?: Response } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  let recipes = [recipe(1, "e2e-222-check"), recipe(2, "Unused")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "DELETE") {
        if (options.remove) return options.remove;
        const id = Number(url.split("/recipes/")[1].split("?")[0]);
        recipes = recipes.filter((item) => item.id !== id);
        return new Response(
          JSON.stringify({
            deleted: id,
            removedUses: url.includes("removeUses=true") ? 2 : 0,
          }),
        );
      }
      if (url.includes("/recipes"))
        return new Response(JSON.stringify(recipes));
      if (url.endsWith("/flight"))
        return new Response(
          JSON.stringify([sequence(options.running ?? false)]),
        );
      if (url.endsWith("/state"))
        return new Response(JSON.stringify({ scenes: [] }));
      if (url.includes("/songs"))
        return new Response(JSON.stringify({ data: [] }));
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

const open = async (canManage = true) => {
  render(<RecipeEditor programId="modoitaliano.tv" canManage={canManage} />);
  await screen.findByRole("list", { name: "Recipes" });
};

it("deletes a recipe with uses after naming them, removing their cues, and lists it no more", async () => {
  const calls = stubApi();
  await open();
  const remove = screen.getByRole("button", { name: "Delete e2e-222-check" });
  expect(remove.dataset.confirm).toBe(
    'Delete "e2e-222-check" and remove its 2 uses from the rundowns?',
  );
  fireEvent.click(remove);
  await screen.findByText(
    'Deleted "e2e-222-check" and removed 2 uses from the rundowns.',
  );
  const call = calls.find((entry) => entry.method === "DELETE")!;
  expect(call.url).toContain(
    "/program/modoitaliano.tv/recipes/1?revision=3&removeUses=true",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Delete e2e-222-check" }),
    ).toBeNull(),
  );
});

it("deletes a recipe without uses with a plain confirmation", async () => {
  const calls = stubApi();
  await open();
  const remove = screen.getByRole("button", { name: "Delete Unused" });
  expect(remove.dataset.confirm).toBe('Delete "Unused"?');
  fireEvent.click(remove);
  await screen.findByText('Deleted "Unused".');
  expect(calls.find((entry) => entry.method === "DELETE")!.url).toMatch(
    /recipes\/2\?revision=3$/,
  );
});

it("offers no delete while a use is on air, nor to someone who cannot manage recipes", async () => {
  stubApi({ running: true });
  await open();
  expect(
    screen.queryByRole("button", { name: "Delete e2e-222-check" }),
  ).toBeNull();
  expect(
    screen.getByText("On air: stop the rundown to delete it"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete Unused" })).toBeTruthy();
  cleanup();
  stubApi();
  await open(false);
  expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
});

it("shows a refusal's reason, and a stale revision as changed elsewhere", async () => {
  stubApi({
    remove: new Response(
      JSON.stringify({
        code: "on_air",
        message: 'A use of this recipe is in the running rundown "e2e".',
      }),
      {
        status: 409,
      },
    ),
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Delete Unused" }));
  await screen.findByText(
    'A use of this recipe is in the running rundown "e2e".',
  );
  cleanup();
  stubApi({
    remove: new Response(
      JSON.stringify({ code: "conflict", message: "changed" }),
      { status: 409 },
    ),
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Delete Unused" }));
  await screen.findByText(/Changed elsewhere/);
});
