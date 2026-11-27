import { apiUrl } from "../utils/apiBaseUrl";
import type { FlightCue } from "../models/broadcast";

/**
 * A recipe of a program (contract C3 of gaulatti/alcantara#222): the steps a song needs around it, the
 * scenes they use, the transition and the hold. `steps` is the ordered list of step keys it runs.
 */
export interface Recipe {
  id: number;
  name: string;
  revision: number;
  steps: string[];
  returnSceneId: number | null;
  bumperSceneId: number | null;
  slideshowSceneId: number | null;
  transitionId: string;
  holdMs: number;
}

export interface RecipeIssue {
  code: string;
  message: string;
}

export interface RecipeExpansion {
  items: FlightCue[];
  issues: RecipeIssue[];
}

/** The recipe changed since it was loaded: another save landed first (HTTP 409). */
export class RecipeConflictError extends Error {
  constructor() {
    super(
      "This recipe changed elsewhere. Reload it, then make your change again.",
    );
    this.name = "RecipeConflictError";
  }
}

async function recipeError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "message" in body ? body.message : null;
  return new Error(
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.join("; ")
        : `Recipe request failed (${response.status})`,
  );
}

const base = (programId: string) =>
  apiUrl(`/program/${encodeURIComponent(programId)}/recipes`);

/** The program's recipes, or null while the API answers 404 (recipes are not on this backend yet). */
export async function fetchRecipes(
  programId: string,
): Promise<Recipe[] | null> {
  const response = await fetch(base(programId));
  if (response.status === 404) return null;
  if (!response.ok) throw await recipeError(response);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Invalid recipes response");
  return payload as Recipe[];
}

/**
 * Creates a recipe from its name. The backend fills the rest: every step, a cut, a 3 s hold, and no
 * scenes yet; a name the show already has is refused with the backend's message.
 */
export async function createRecipe(
  programId: string,
  name: string,
): Promise<Recipe> {
  const response = await fetch(base(programId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw await recipeError(response);
  return (await response.json()) as Recipe;
}

/** The saved recipe, and how many uses of it that had not aired followed the change (the backend rebuilt them). */
export interface RecipeSaved {
  recipe: Recipe;
  rebuilt: number;
}

/** Saves a recipe with the revision it was loaded at; the backend compares and sets on it. */
export async function updateRecipe(
  programId: string,
  recipe: Recipe,
): Promise<RecipeSaved> {
  const response = await fetch(`${base(programId)}/${recipe.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: recipe.name,
      steps: recipe.steps,
      returnSceneId: recipe.returnSceneId,
      bumperSceneId: recipe.bumperSceneId,
      slideshowSceneId: recipe.slideshowSceneId,
      transitionId: recipe.transitionId,
      holdMs: recipe.holdMs,
      revision: recipe.revision,
    }),
  });
  if (response.status === 409) throw new RecipeConflictError();
  if (!response.ok) throw await recipeError(response);
  // The answer is the recipe as saved plus `rebuilt`; the count is not part of the recipe.
  const { rebuilt, ...saved } = (await response.json()) as Recipe & {
    rebuilt?: number;
  };
  return { recipe: saved, rebuilt: typeof rebuilt === "number" ? rebuilt : 0 };
}

/** A preview of the cues a use for this song would be written as. It saves nothing. */
export async function expandRecipe(
  programId: string,
  recipeId: number,
  params: { songId: number; labelId?: string | null },
  /** Builds the same use again (its cues keep their ids), as when its label changes (gaulatti/alcantara#425). */
  useId?: string,
): Promise<RecipeExpansion> {
  const response = await fetch(`${base(programId)}/${recipeId}/expand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(useId ? { params, useId } : { params }),
  });
  if (!response.ok) throw await recipeError(response);
  const payload = (await response.json()) as Partial<RecipeExpansion>;
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    issues: Array.isArray(payload.issues) ? payload.issues : [],
  };
}

/** Why the API refused a recipe delete (gaulatti/alcantara#465): a use on air, uses left, or a stale revision. */
export class RecipeDeleteRefusal extends Error {
  constructor(
    readonly code: "on_air" | "has_uses" | "conflict",
    message: string,
    readonly uses?: number,
  ) {
    super(message);
    this.name = "RecipeDeleteRefusal";
  }
}

/**
 * Deletes a recipe read at its revision (gaulatti/alcantara#465). `removeUses` removes its use cues from
 * the rundowns first; without it, a recipe with uses is refused.
 */
export async function deleteRecipe(
  programId: string,
  recipe: Pick<Recipe, "id" | "revision">,
  removeUses: boolean,
): Promise<{ deleted: number; removedUses: number }> {
  const query = new URLSearchParams({ revision: String(recipe.revision) });
  if (removeUses) query.set("removeUses", "true");
  const response = await fetch(`${base(programId)}/${recipe.id}?${query}`, {
    method: "DELETE",
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      uses?: unknown;
    } | null;
    const code =
      body?.code === "on_air" || body?.code === "has_uses"
        ? body.code
        : "conflict";
    throw new RecipeDeleteRefusal(
      code,
      typeof body?.message === "string"
        ? body.message
        : "This recipe changed elsewhere. Reload it first.",
      typeof body?.uses === "number" ? body.uses : undefined,
    );
  }
  if (!response.ok) throw await recipeError(response);
  return (await response.json()) as { deleted: number; removedUses: number };
}
