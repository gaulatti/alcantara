# Brand-Literal Ratchet

The brand-literal ratchet invariant prevents new customer-branded code or files from being introduced into Alcantara's core backend (`backend/src`) and frontend (`frontend/app`) trees.

## Invariant Specification

- **Brand Words Monitored**: `modoitaliano`, `fifthbell`, `earone`, `toni`, `giorgia`, `reloj`, `sanremo`, `cronica`.
- **Monitored Source Trees**:
  - `backend/src` (tree key: `backend`)
  - `frontend/app` (tree key: `frontend`)
- **Baseline Storage**: `scripts/brand-baselines/<tree>/<word>.json`
  - Each JSON file stores `{ "count": N }`, representing the maximum allowable number of matching files for that brand word in that tree.
  - The baselines equal the counts at the commit that introduced the ratchet. The spec requires every count to stay at or below its baseline, never to equal it, so a retirement passes.
- **Excluded**: only the tree root's own `invariants` folder, which holds the ratchet and its spec. A nested folder or file named `invariants` elsewhere is scanned like any other.
- **Matching is a case-insensitive substring**, so a short brand word can also match an ordinary word that contains it. Such a match counts toward the baseline like any other.

## Ratchet Rules

1. **Path and Content Inspection**: A file is classified as matching a brand word if either its relative path within the tree or its text content contains the word (case-insensitive).
2. **Failure on Excess**: If a PR or commit causes the number of matching files in a tree to exceed the stored baseline count, `backend/src/invariants/brand-literals.spec.ts` fails.
3. **Ratchet Downward on Retirement**: When customer code is retired and branded files are removed or cleaned, the test passes and prints a reminder:
   ```
   [brand-ratchet] Reminder: lower baseline for <tree>/<word> from <old> to <new>
   ```
   The developer or agent retiring the brand code updates only that specific `<tree>/<word>.json` counter to the new lower count, locking in the reduction.

## Retired renderers (gaulatti/alcantara#382, #391)

The Modo Italiano renderers (chyron, clock, bracket, podcast player and the Giorgia family) are `@modoitaliano/giorgia`'s. The local copies, their readers and the unused disclaimer were deleted, so `frontend/modoitaliano` is 22 and `frontend/giorgia` is 19. `frontend/app/scenes/packagedScenes.tsx` is the one place the app loads them, and `frontend/app/scenes/noLocalRenderers.test.ts` fails if a renderer named for the brand is added under `frontend/app/components/`.
