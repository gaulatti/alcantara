# Renderer keys per program

The machines that serve a program (the return runner, the on-air contribution worker, and the pages that bring guests
into a program feed) authenticate with a renderer key. Each program has its own key (gaulatti/alcantara#884).

## Storage

`ProgramRendererKey` holds one row per program: the key's SHA-256 (`keyHash`, unique), its `version`, and when it was
created, last rotated and last used. The key itself is never stored, logged or shown again after it is issued. A key is
`alrk_` followed by 32 random bytes in base64url.

`lastUsedAt` is written at most once a minute per program, so polling callers do not write on every call. A failed
write is logged by its error class only and never fails the caller's request.

The migration is additive. Rollback: `DROP TABLE "ProgramRendererKey";`.

## Issue and rotate

| Route | Permission | Answer |
| --- | --- | --- |
| `GET /program/:programId/renderer-key` | `program.read` | `{ programId, exists, version, createdAt, rotatedAt, lastUsedAt }`: never the key or its hash. |
| `POST /program/:programId/renderer-key/rotate` | `program.manage` | The same metadata plus `key`, the new clear key, this once. |

Both answers are `Cache-Control: no-store`. A rotation replaces the previous key at once: the old key stops working
on its next use. Both routes are scoped to the caller's team like every program route, and answer 404 for a program that
does not exist.

Each rotation is recorded as an operator change (who, when, through which route) under the program, with `rendererKey`
named but never valued and `version` valued before and after.

## Checks and migration

The checks on the calls endpoints, the fleet credential for the cross-program router list, and the holders' move to
per-program keys follow in later steps of #884. Until then every caller keeps using its current credential.
