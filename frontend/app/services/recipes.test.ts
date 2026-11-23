import { afterEach, expect, it, vi } from "vitest";
import { RecipeConflictError, expandRecipe, fetchRecipes, updateRecipe, type Recipe } from "./recipes";

afterEach(() => vi.unstubAllGlobals());

const recipe: Recipe = {
  id: 5, name: "Song", revision: 3, steps: ["a"], returnSceneId: null, bumperSceneId: 1, slideshowSceneId: 2, transitionId: "cut", holdMs: 3000,
};
const answer = (response: Response) => vi.stubGlobal("fetch", vi.fn(async () => response));

it("reads the recipes of a program, and null while the API answers 404", async () => {
  answer(new Response(JSON.stringify([recipe])));
  await expect(fetchRecipes("tv main")).resolves.toEqual([recipe]);
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/programs/tv%20main/recipes");
  answer(new Response("{}", { status: 404 }));
  await expect(fetchRecipes("tv")).resolves.toBeNull();
});

it("reports a failed or malformed list, with the reason when the API gives one", async () => {
  answer(new Response(JSON.stringify({ message: "database down" }), { status: 500 }));
  await expect(fetchRecipes("tv")).rejects.toThrow("database down");
  answer(new Response(JSON.stringify({ message: ["name must be a string", "holdMs must be a number"] }), { status: 400 }));
  await expect(fetchRecipes("tv")).rejects.toThrow("name must be a string; holdMs must be a number");
  answer(new Response("not json", { status: 502 }));
  await expect(fetchRecipes("tv")).rejects.toThrow("Recipe request failed (502)");
  answer(new Response(JSON.stringify({ message: 42 }), { status: 500 }));
  await expect(fetchRecipes("tv")).rejects.toThrow("Recipe request failed (500)");
  answer(new Response(JSON.stringify({ not: "a list" })));
  await expect(fetchRecipes("tv")).rejects.toThrow("Invalid recipes response");
});

it("saves with the revision, and tells a stale revision from any other refusal", async () => {
  answer(new Response(JSON.stringify({ ...recipe, revision: 4 })));
  await expect(updateRecipe("tv", recipe)).resolves.toMatchObject({ revision: 4 });
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toContain("/programs/tv/recipes/5");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    name: "Song", steps: ["a"], returnSceneId: null, bumperSceneId: 1, slideshowSceneId: 2, transitionId: "cut", holdMs: 3000, revision: 3,
  });
  answer(new Response("{}", { status: 409 }));
  await expect(updateRecipe("tv", recipe)).rejects.toBeInstanceOf(RecipeConflictError);
  answer(new Response(JSON.stringify({ message: "Scene 1 is not assigned" }), { status: 400 }));
  await expect(updateRecipe("tv", recipe)).rejects.toThrow("Scene 1 is not assigned");
});

it("previews the cues and issues of a use, tolerating an answer that lacks either", async () => {
  answer(new Response(JSON.stringify({ items: [{ id: "x", kind: "playSong" }], issues: [{ code: "label_empty", message: "m" }] })));
  await expect(expandRecipe("tv", 5, { songId: 7 })).resolves.toEqual({
    items: [{ id: "x", kind: "playSong" }],
    issues: [{ code: "label_empty", message: "m" }],
  });
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toContain("/programs/tv/recipes/5/expand");
  expect(JSON.parse(init.body)).toEqual({ params: { songId: 7 } });
  answer(new Response("{}"));
  await expect(expandRecipe("tv", 5, { songId: 7 })).resolves.toEqual({ items: [], issues: [] });
  answer(new Response(JSON.stringify({ message: "A radio show has no recipes" }), { status: 400 }));
  await expect(expandRecipe("tv", 5, { songId: 7 })).rejects.toThrow("A radio show has no recipes");
});
