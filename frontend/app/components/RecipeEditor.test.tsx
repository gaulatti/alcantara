import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RecipeEditor, { RECIPE_STEPS, describeCue, usesNotYetAired, usesOfRecipe } from "./RecipeEditor";
import type { FlightCue, FlightSequence } from "../models/broadcast";

// Radix positioning runs continuously in jsdom; keep Bleecker's string callback contract with a
// native select, as the other Bleecker-select tests in this repo do.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const keys = RECIPE_STEPS.map((step) => step.key);
const recipe = {
  id: 5,
  name: "Song",
  revision: 3,
  steps: keys,
  returnSceneId: 30,
  bumperSceneId: 10,
  slideshowSceneId: 20,
  transitionId: "crescendo-prism",
  holdMs: 3000,
};
const scenes = [10, 20, 30].map((id) => ({ scene: { id, name: ["Bumper", "Slides", "Desk"][id / 10 - 1] } }));
const songs = [{ id: 7, artist: "Rob", title: "Anthem" }];
const tag = (useId: string, step: string) => ({ recipeUse: { useId, recipeId: 5, step } });
const cue = (id: string, extra: object = {}): FlightCue => ({ id, kind: "wait", ...extra }) as FlightCue;
const sequence = (overrides: Partial<FlightSequence> = {}): FlightSequence =>
  ({
    id: 1,
    name: "Evening",
    items: [
      cue("use_a.show", { ...tag("use_a", "bumper") }),
      cue("use_a.back", { ...tag("use_a", "back") }),
      cue("plain"),
      cue("use_b.show", { ...tag("use_b", "bumper") }),
    ],
    loop: false,
    isRunning: false,
    activeItemId: null,
    scheduledAt: null,
    publishedAt: null,
    revision: 1,
    lastStartedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  }) as FlightSequence;

interface Options {
  rebuilt?: number;
  state?: Response;
  songs?: Response;
  putFails?: unknown;
  expandFails?: unknown;
  recipes?: unknown;
  recipesStatus?: number;
  sequences?: FlightSequence[];
  put?: (body: Record<string, unknown>) => Response;
  expand?: Response;
}

function stubApi(options: Options = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      if (url.includes("/recipes/5/expand")) {
        if (options.expandFails !== undefined) throw options.expandFails;
        return options.expand ?? new Response(JSON.stringify({ items: [], issues: [] }));
      }
      if (url.includes("/recipes/5") && method === "PUT") {
        if (options.putFails !== undefined) throw options.putFails;
        return options.put ? options.put(body!) : new Response(JSON.stringify({ ...recipe, ...body, revision: 4, rebuilt: options.rebuilt ?? 2 }));
      }
      if (url.includes("/recipes"))
        return new Response(JSON.stringify(options.recipes ?? [recipe]), { status: options.recipesStatus ?? 200 });
      if (url.endsWith("/flight")) return new Response(JSON.stringify(options.sequences ?? [sequence()]));
      if (url.endsWith("/state")) return options.state ?? new Response(JSON.stringify({ scenes }));
      if (url.includes("/songs")) return options.songs ?? new Response(JSON.stringify({ data: songs }));
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

const open = async (canManage = true) => {
  render(<RecipeEditor programId="tv-main" canManage={canManage} />);
  await screen.findByRole("region", { name: "Recipe Song" });
};

it("lists the recipes with their revision and how many uses each has", async () => {
  stubApi();
  await open();
  expect(within(screen.getByRole("list", { name: "Recipes" })).getByText("Revision 3 · 2 uses")).toBeTruthy();
});

it("saves an edit with the revision it was loaded at, after naming how many uses will follow", async () => {
  const calls = stubApi();
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.change(screen.getByLabelText("Bumper scene"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Hold the bumper (seconds)"), { target: { value: "4.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  expect(screen.getByRole("status").textContent).toContain("2 uses that have not aired yet will be rebuilt");
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. 2 upcoming uses were rebuilt from it.");
  const put = calls.find((call) => call.method === "PUT")!;
  expect(put.url).toContain("/program/tv-main/recipes/5");
  expect(put.body).toEqual({
    name: "Song",
    steps: keys,
    returnSceneId: 30,
    bumperSceneId: null,
    slideshowSceneId: 20,
    transitionId: "cut",
    holdMs: 4500,
    revision: 3,
  });
  expect(screen.getByText("Revision 4 · 2 uses")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save recipe" })).toBeDisabled();
});

it("turns a step off by leaving it out of the saved steps, and back on in its place", async () => {
  const calls = stubApi({ put: (body) => new Response(JSON.stringify({ ...recipe, ...body, revision: 4 })) });
  await open();
  const hold = screen.getByRole("switch", { name: "Hold the bumper" });
  fireEvent.click(hold);
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText(/Recipe saved/);
  expect(calls.find((call) => call.method === "PUT")!.body!.steps).toEqual(keys.filter((key) => key !== "hold"));
  fireEvent.click(screen.getByRole("switch", { name: "Hold the bumper" }));
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2));
  expect(calls.filter((call) => call.method === "PUT")[1].body!.steps).toEqual(keys);
});

it("keeps a step the editor does not know, and clamps and rounds the hold", async () => {
  const calls = stubApi({ recipes: [{ ...recipe, steps: [...keys, "extra-step"] }] });
  await open();
  expect(screen.getByRole("switch", { name: "extra-step" })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Hold the bumper (seconds)"), { target: { value: "99" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText(/Recipe saved/);
  const body = calls.find((call) => call.method === "PUT")!.body!;
  expect(body.steps).toEqual([...keys, "extra-step"]);
  expect(body.holdMs).toBe(60000);
  fireEvent.change(screen.getByLabelText("Hold the bumper (seconds)"), { target: { value: "" } });
  expect((screen.getByLabelText("Hold the bumper (seconds)") as HTMLInputElement).value).toBe("0");
});

it("says the recipe changed elsewhere on a 409 and reloads it on request", async () => {
  const calls = stubApi({ put: () => new Response("{}", { status: 409 }) });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Changed elsewhere");
  expect(screen.getByRole("button", { name: "Save recipe" })).toBeDisabled();
  const before = calls.filter((call) => call.url.includes("/recipes") && call.method === "GET").length;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByRole("region", { name: "Recipe Song" });
  expect(calls.filter((call) => call.url.includes("/recipes") && call.method === "GET").length).toBe(before + 1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows the reason when a save is refused for another reason", async () => {
  stubApi({ put: () => new Response(JSON.stringify({ message: "Scene 10 is not assigned to this program" }), { status: 400 }) });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Scene 10 is not assigned to this program");
  // The confirmation stays open to try again, or to cancel.
  expect(screen.getByRole("button", { name: "Confirm save" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Save recipe" })).toBeTruthy();
});

it("previews the steps and issues of a use for a song, and saves nothing", async () => {
  const items = [
    { id: "u.a", kind: "sceneUpdate", sceneId: 10 },
    { id: "u.b", kind: "scene", sceneId: 10, transitionId: "crescendo-prism" },
    { id: "u.c", kind: "wait", durationMs: 3000 },
    { id: "u.d", kind: "playSong", songId: 7 },
    { id: "u.e", kind: "sceneUpdate", sceneId: 20 },
    { id: "u.f", kind: "scene", sceneId: 20 },
    { id: "u.g", kind: "waitForSongEnd" },
    { id: "u.h", kind: "scene", sceneId: 30, transitionId: "cut" },
  ];
  const calls = stubApi({
    expand: new Response(JSON.stringify({ items, issues: [{ code: "artist_label_missing", message: "Rob has no artist label" }] })),
  });
  await open();
  expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Song to preview"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const steps = await screen.findByRole("list", { name: "Preview steps" });
  expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Point Bumper at the song",
    "Show Bumper (crescendo-prism)",
    "Hold for 3 s",
    "Play the song",
    "Point Slides at the song",
    "Show Slides (cut)",
    "Wait for the song to end",
    "Show Desk (cut)",
  ]);
  expect(within(screen.getByRole("list", { name: "Issues" })).getByText("artist_label_missing")).toBeTruthy();
  expect(calls.find((call) => call.url.endsWith("/expand"))!.body).toEqual({ params: { songId: 7 } });
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

it("says there are no issues, and why a preview failed", async () => {
  stubApi({ expand: new Response(JSON.stringify({ items: [{ id: "x", kind: "playSong" }], issues: [] })) });
  await open();
  fireEvent.change(screen.getByLabelText("Song to preview"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("No issues.");
  cleanup();
  stubApi({ expand: new Response(JSON.stringify({ message: "A radio show has no recipes" }), { status: 400 }) });
  await open();
  fireEvent.change(screen.getByLabelText("Song to preview"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect((await screen.findByRole("alert")).textContent).toBe("A radio show has no recipes");
});

it("is read only without flight.manage", async () => {
  stubApi();
  await open(false);
  expect(screen.getByText("Read only: you cannot change recipes")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save recipe" })).toBeNull();
  for (const name of ["Transition", "Bumper scene", "Slideshow scene", "Return scene"])
    expect(screen.getByLabelText(name)).toBeDisabled();
  expect(screen.getByLabelText("Hold the bumper (seconds)")).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Hold the bumper" })).toBeDisabled();
});

it("shows an empty state while recipes answer 404, and another when there are none", async () => {
  stubApi({ recipesStatus: 404 });
  render(<RecipeEditor programId="tv-main" canManage />);
  await screen.findByText("Recipes are not available yet");
  cleanup();
  stubApi({ recipes: [] });
  render(<RecipeEditor programId="tv-main" canManage />);
  await screen.findByText("No recipes in this show yet");
});

it("shows why recipes could not be loaded, and retries", async () => {
  stubApi({ recipesStatus: 500, recipes: { message: "database down" } });
  render(<RecipeEditor programId="tv-main" canManage />);
  expect(await screen.findByText("database down")).toBeTruthy();
  stubApi();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "Recipe Song" });
  cleanup();
  stubApi({ recipes: { not: "a list" } });
  render(<RecipeEditor programId="tv-main" canManage />);
  expect(await screen.findByText("Invalid recipes response")).toBeTruthy();
});

it("switches between recipes and clears what belonged to the previous one", async () => {
  stubApi({ recipes: [recipe, { ...recipe, id: 6, name: "Jingle", revision: 1 }] });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: /^Jingle/ }));
  await screen.findByRole("region", { name: "Recipe Jingle" });
  expect(screen.getByLabelText("Transition")).toHaveValue("crescendo-prism");
  expect(screen.getByText("Revision 1 · 0 uses")).toBeTruthy();
});

it("counts the uses of a recipe by use id, and those that have not aired yet", () => {
  const idle = sequence();
  expect(usesOfRecipe([idle], 5).map((use) => [use.useId, use.cues.length])).toEqual([["use_a", 2], ["use_b", 1]]);
  expect(usesOfRecipe([idle], 99)).toEqual([]);
  expect(usesNotYetAired([idle], 5)).toBe(2);
  // Running with the first use on air: only the use after it follows the recipe.
  const running = sequence({ isRunning: true, activeItemId: "use_a.show" });
  expect(usesNotYetAired([running], 5)).toBe(1);
  expect(usesNotYetAired([sequence({ isRunning: true, activeItemId: null })], 5)).toBe(2);
});

it("describes every kind of cue the recipe writes, and any other by its label or kind", () => {
  const known = [{ id: 1, name: "Bumper" }] as never;
  expect(describeCue({ id: "a", kind: "scene", sceneId: 9 } as FlightCue, known)).toBe("Show scene 9 (cut)");
  expect(describeCue({ id: "a", kind: "sceneUpdate" } as FlightCue, known)).toBe("Point scene ? at the song");
  expect(describeCue({ id: "a", kind: "wait" } as FlightCue, known)).toBe("Hold for 0 s");
  expect(describeCue({ id: "a", kind: "instant", label: "Ident" } as FlightCue, known)).toBe("Ident");
  expect(describeCue({ id: "a", kind: "instant" } as FlightCue, known)).toBe("instant");
});

it("opens without scenes or songs when the show state and the catalog cannot be read", async () => {
  stubApi({ state: new Response("{}", { status: 500 }), songs: new Response("{}", { status: 500 }) });
  await open();
  expect(within(screen.getByLabelText("Bumper scene")).getAllByRole("option")).toHaveLength(1);
  expect(within(screen.getByLabelText("Song to preview")).getAllByRole("option")).toHaveLength(1);
  cleanup();
  stubApi({
    state: new Response(JSON.stringify({ scenes: [{ scene: null }, { scene: { id: 10, name: "Bumper" } }] })),
    songs: new Response(JSON.stringify({ data: "nope" })),
  });
  await open();
  expect(within(screen.getByLabelText("Bumper scene")).getAllByRole("option")).toHaveLength(2);
  cleanup();
  stubApi({ state: new Response(JSON.stringify({ scenes: "nope" })) });
  await open();
  expect(within(screen.getByLabelText("Bumper scene")).getAllByRole("option")).toHaveLength(1);
});

it("reports a load that fails with something that is not an Error", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject("offline")));
  render(<RecipeEditor programId="tv-main" canManage />);
  expect(await screen.findByText("offline")).toBeTruthy();
});

it("picks a scene by id, and says nothing was rebuilt when no upcoming use follows the recipe", async () => {
  stubApi({ sequences: [], rebuilt: 0 });
  await open();
  fireEvent.change(screen.getByLabelText("Bumper scene"), { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  expect(screen.getByRole("status").textContent).toContain("No use that has not aired yet follows this recipe");
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. No upcoming use needed a rebuild.");
});

it("names one use in the singular", async () => {
  stubApi({ rebuilt: 1, sequences: [sequence({ items: [cue("use_a.show", { ...tag("use_a", "bumper") })] })] });
  await open();
  expect(screen.getByText("Revision 3 · 1 use")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  expect(screen.getByRole("status").textContent).toContain("1 use that has not aired yet will be rebuilt");
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. 1 upcoming use was rebuilt from it.");
});

it("reads the saved recipe and the count of rebuilt uses from the update, and keeps the count out of the recipe", async () => {
  const calls = stubApi({ rebuilt: 3 });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. 3 upcoming uses were rebuilt from it.");
  // The saved recipe is not dirty (the count is not a field of it), so there is nothing more to save.
  expect(screen.getByRole("button", { name: "Save recipe" })).toBeDisabled();
  expect(calls.find((call) => call.method === "PUT")!.body).not.toHaveProperty("rebuilt");
});

it("reports a save or a preview that fails with something that is not an Error", async () => {
  stubApi({ putFails: "offline", expandFails: "unreachable" });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("offline");
  fireEvent.change(screen.getByLabelText("Song to preview"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect((await screen.findByRole("alert")).textContent).toBe("unreachable");
});

it("shows nothing for a recipe that disappeared on reload", async () => {
  stubApi({ put: () => new Response("{}", { status: 409 }) });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByRole("alert");
  stubApi({ recipes: [{ ...recipe, id: 6, name: "Other" }] });
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Recipe Song" })).toBeNull());
  expect(screen.getByRole("list", { name: "Recipes" })).toBeTruthy();
});

it("replaces only the saved recipe in the list", async () => {
  stubApi({ recipes: [recipe, { ...recipe, id: 6, name: "Jingle", revision: 1 }] });
  await open();
  fireEvent.change(screen.getByLabelText("Transition"), { target: { value: "cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Revision 4 · 2 uses");
  expect(screen.getByText("Revision 1 · 0 uses")).toBeTruthy();
});

it("picks the slideshow scene by id, and saves it", async () => {
  stubApi({ sequences: [], rebuilt: 0 });
  await open();
  fireEvent.change(screen.getByLabelText("Slideshow scene"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. No upcoming use needed a rebuild.");
});

it("renames the recipe and picks its return scene, then saves both", async () => {
  stubApi({ sequences: [], rebuilt: 0 });
  await open();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed song" } });
  expect(screen.getByLabelText("Name")).toHaveValue("Renamed song");
  fireEvent.change(screen.getByLabelText("Return scene"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Recipe saved. No upcoming use needed a rebuild.");
});
