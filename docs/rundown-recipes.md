# Rundown recipes (gaulatti/alcantara#424)

A **recipe** is a named, reusable set of rundown steps on a program with a television leg. Adding
one **use** of it to an operator rundown writes ordinary rundown cues (the eight existing kinds), so
the engine, the resolver and the console run it like any hand-built cues. The design, its
alternatives and the owner's open questions are on gaulatti/alcantara#222.

## The song recipe

Its only input is the song. The eight steps, in the order they air (the step keys are binding):

| Key | Cue | What it does |
|---|---|---|
| `bumperPoint` | `sceneUpdate` on the bumper scene | Points the Giorgia artist bumper (`modoitaliano-giorgia-artist-bumper`) at the song: `artist`, `songTitle`, `labelId` |
| `bumper` | `scene` | Shows the bumper with the recipe's transition |
| `hold` | `wait` | Holds it for `holdMs` (default 3000; 0 adds no cue) |
| `song` | `playSong` | Plays the song |
| `slideshowPoint` | `sceneUpdate` on the slideshow scene | Points the slideshow (`slideshow`) at the label |
| `slideshow` | `scene` | Shows the slideshow |
| `songEnd` | `waitForSongEnd` | Holds until the song ends. On TV the program page reports the end (`song_ended`) |
| `back` | `scene` | Goes to the recipe's return scene |

`steps` lists the enabled keys. The server stores them in airing order and refuses an unknown key. A
step whose scene isn't set on the recipe is left out of a use.

**The label** is the use's own `labelId` when one is given. Otherwise it is the artist's media label
(gaulatti/alcantara#423, reached through the `ARTIST_LABEL_LOOKUP` port, which answers `null` until
gaulatti/alcantara#427 binds it). Otherwise the use has none.

## A use in a rundown

- Every cue of a use carries `recipeUse: { useId, recipeId, recipeRevision, step, params: { songId, labelId } }`.
- Its id is `<useId>.<step>`, with `useId` = `use_` + 12 hex characters, so a rebuild keeps ids and
  the engine's bindings to them.
- The cues are saved only once gaulatti/alcantara#422 keeps the tag through the rundown's normaliser.
  Until then a use still plays; it just isn't grouped.
- **Rebuild.** When a recipe is saved, each use of it built from an older revision, in this program's
  operator rundowns, is built again with the same `useId`, song and label, at the same place. A use
  at or before the cue on air is left as it is. A use whose tagged cues are no longer contiguous
  isn't rebuilt. Cues detached in the console (no tag) are never touched.

## API (`flight.read` to read, `flight.manage` to write)

| Route | Body | Answer |
|---|---|---|
| `GET /program/:programId/recipes` | | The recipes: `{id, name, revision, bumperSceneId, slideshowSceneId, returnSceneId, transitionId, holdMs, steps}` |
| `POST /program/:programId/recipes` | `name` and any of the fields | The recipe. Scenes must be assigned to the program. A `radio` program gets 400 |
| `PUT /program/:programId/recipes/:recipeId` | `revision` and the fields to change | `{recipe, rebuilt}`. A stale revision gets 409 `{statusCode: 409, message, error: "Conflict"}` |
| `POST /program/:programId/recipes/:recipeId/expand` | `{params: {songId, labelId?}, useId?}` | `{items, issues}`. A preview: nothing is written |

**Issue codes:**
- `song_unavailable`: the song is missing, disabled, or has no audio;
- `artist_label_missing`: no label resolved;
- `label_empty`: the label has no images;
- `scene_not_assigned`: a recipe scene is no longer assigned to the program;
- `scene_wrong_layout`: the bumper or slideshow scene lacks its component;
- `scene_shared`: the bumper or slideshow scene belongs to more than one program, and each use re-points it.

**MCP:** `program_list_recipes_by_id`, `program_expand_recipe_by_id`, `program_create_recipe_by_id`,
`program_update_recipe_by_id` and `program_add_recipe_use_by_id` (`docs/mcp-capabilities.md`).

## Metrics

- `alcantara_recipe_expansions_total{result}`: uses previewed or built. `result` is `ok`, `issues`
  (built, with something to fix) or `rejected` (a refused request).
- `alcantara_recipe_rebuilds_total{result}`: uses after a recipe change. `result` is `rebuilt`,
  `skipped` (on air or already played) or `conflict` (the rundown changed at the same moment; reload).

Neither metric has any other label.

## Local data

The seed adds a "Song" recipe to `tv-demo`. Its bumper scene ("Local artist bumper") and slideshow
scene ("Local song slideshow") are assigned only to `tv-demo`, and it returns to "Local program desk".
