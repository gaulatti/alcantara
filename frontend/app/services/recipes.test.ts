import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecipeConflictError,
  RecipeDeleteRefusal,
  createRecipe,
  deleteRecipe,
  expandRecipe,
  fetchRecipes,
  updateRecipe,
  type Recipe,
} from "./recipes";

afterEach(() => vi.unstubAllGlobals());

const recipe: Recipe = {
  id: 5,
  name: "Song",
  revision: 3,
  steps: ["a"],
  returnSceneId: null,
  bumperSceneId: 1,
  slideshowSceneId: 2,
  transitionId: "cut",
  holdMs: 3000,
};
const answer = (response: Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );

it("reads the recipes of a program, and null while the API answers 404", async () => {
  answer(new Response(JSON.stringify([recipe])));
  await expect(fetchRecipes("tv main")).resolves.toEqual([recipe]);
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
    "/program/tv%20main/recipes",
  );
  answer(new Response("{}", { status: 404 }));
  await expect(fetchRecipes("tv")).resolves.toBeNull();
});

it("reports a failed or malformed list, with the reason when the API gives one", async () => {
  answer(
    new Response(JSON.stringify({ message: "database down" }), { status: 500 }),
  );
  await expect(fetchRecipes("tv")).rejects.toThrow("database down");
  answer(
    new Response(
      JSON.stringify({
        message: ["name must be a string", "holdMs must be a number"],
      }),
      { status: 400 },
    ),
  );
  await expect(fetchRecipes("tv")).rejects.toThrow(
    "name must be a string; holdMs must be a number",
  );
  answer(new Response("not json", { status: 502 }));
  await expect(fetchRecipes("tv")).rejects.toThrow(
    "Recipe request failed (502)",
  );
  answer(new Response(JSON.stringify({ message: 42 }), { status: 500 }));
  await expect(fetchRecipes("tv")).rejects.toThrow(
    "Recipe request failed (500)",
  );
  answer(new Response(JSON.stringify({ not: "a list" })));
  await expect(fetchRecipes("tv")).rejects.toThrow("Invalid recipes response");
});

it("saves with the revision, and tells a stale revision from any other refusal", async () => {
  answer(new Response(JSON.stringify({ ...recipe, revision: 4, rebuilt: 2 })));
  await expect(updateRecipe("tv", recipe)).resolves.toEqual({
    recipe: { ...recipe, revision: 4 },
    rebuilt: 2,
  });
  // An answer without the count (an older backend) means nothing was reported rebuilt.
  answer(new Response(JSON.stringify({ ...recipe, revision: 5 })));
  await expect(updateRecipe("tv", recipe)).resolves.toEqual({
    recipe: { ...recipe, revision: 5 },
    rebuilt: 0,
  });
  answer(new Response(JSON.stringify({ ...recipe, revision: 4, rebuilt: 2 })));
  await updateRecipe("tv", recipe);
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toContain("/program/tv/recipes/5");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    name: "Song",
    steps: ["a"],
    returnSceneId: null,
    bumperSceneId: 1,
    slideshowSceneId: 2,
    transitionId: "cut",
    holdMs: 3000,
    revision: 3,
  });
  answer(new Response("{}", { status: 409 }));
  await expect(updateRecipe("tv", recipe)).rejects.toBeInstanceOf(
    RecipeConflictError,
  );
  answer(
    new Response(JSON.stringify({ message: "Scene 1 is not assigned" }), {
      status: 400,
    }),
  );
  await expect(updateRecipe("tv", recipe)).rejects.toThrow(
    "Scene 1 is not assigned",
  );
});

it("previews the cues and issues of a use, tolerating an answer that lacks either", async () => {
  answer(
    new Response(
      JSON.stringify({
        items: [{ id: "x", kind: "playSong" }],
        issues: [{ code: "label_empty", message: "m" }],
      }),
    ),
  );
  await expect(expandRecipe("tv", 5, { songId: 7 })).resolves.toEqual({
    items: [{ id: "x", kind: "playSong" }],
    issues: [{ code: "label_empty", message: "m" }],
  });
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toContain("/program/tv/recipes/5/expand");
  expect(JSON.parse(init.body)).toEqual({ params: { songId: 7 } });
  answer(new Response("{}"));
  await expandRecipe("tv", 5, { songId: 7 }, "use-9");
  const [, rebuildInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  expect(JSON.parse(rebuildInit.body)).toEqual({ params: { songId: 7 }, useId: "use-9" });
  answer(new Response("{}"));
  await expect(expandRecipe("tv", 5, { songId: 7 })).resolves.toEqual({
    items: [],
    issues: [],
  });
  answer(
    new Response(JSON.stringify({ message: "A radio show has no recipes" }), {
      status: 400,
    }),
  );
  await expect(expandRecipe("tv", 5, { songId: 7 })).rejects.toThrow(
    "A radio show has no recipes",
  );
});

describe("deleteRecipe (gaulatti/alcantara#465)", () => {
  it("sends the revision, and removeUses only when asked", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ deleted: 5, removedUses: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).resolves.toEqual({ deleted: 5, removedUses: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/program\/tv\/recipes\/5\?revision=3$/,
    );
    await deleteRecipe("tv", { id: 5, revision: 3 }, true);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(
      /revision=3&removeUses=true$/,
    );
    vi.unstubAllGlobals();
  });

  it("turns a 409 into a refusal with its code and count, and other failures into errors", async () => {
    const answer = (status: number, body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              typeof body === "string" ? body : JSON.stringify(body),
              { status },
            ),
        ),
      );
    answer(409, { code: "has_uses", message: "has 2", uses: 2 });
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).rejects.toMatchObject({ code: "has_uses", uses: 2, message: "has 2" });
    answer(409, { code: "on_air", message: "running" });
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).rejects.toMatchObject({ code: "on_air", uses: undefined });
    answer(409, "not json");
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This recipe changed elsewhere. Reload it first.",
    });
    answer(409, { code: "conflict", message: 5 });
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).rejects.toBeInstanceOf(RecipeDeleteRefusal);
    answer(500, { message: "boom" });
    await expect(
      deleteRecipe("tv", { id: 5, revision: 3 }, false),
    ).rejects.toThrow("boom");
    vi.unstubAllGlobals();
  });
});

it("creates a recipe from its name, and reports the backend's refusal", async () => {
  answer(new Response(JSON.stringify(recipe), { status: 201 }));
  await expect(createRecipe("tv main", "Song")).resolves.toEqual(recipe);
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toContain("/program/tv%20main/recipes");
  expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "Song" }) });
  answer(new Response(JSON.stringify({ message: "a recipe needs a name" }), { status: 400 }));
  await expect(createRecipe("tv", "")).rejects.toThrow("a recipe needs a name");
});
