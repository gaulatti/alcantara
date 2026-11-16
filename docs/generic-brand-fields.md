# Generic Audience Interaction and Chart Identity

Alcantara carries audience interaction and song chart data under generic names, next to the existing branded ones. This is live for every program: there is no setting to turn it on or off. The branded names stay, so existing clients keep working unchanged.

## Generic audience interaction brackets

### Component support
Bracket draws and votes run for the scene's audience-interaction component. The component type is chosen in this order:

1. The requested `componentType`, when it is an audience-interaction component (its name contains `bracket` or `audience.interaction`, for example `harbor-light-bracket` or `poll.audience.interaction`).
2. Otherwise the scene layout's `componentType`, when it is one.
3. Otherwise `modoitaliano-bracket`, which is what every request used before. An unrecognized type still falls back to it instead of being refused.

The bracket state is read from and written to the scene metadata under that component type's key.

### Realtime broadcast signals
During a bracket draw (`drawModoItalianoBracket`) the server broadcasts both the generic and the legacy events to every program the scene is assigned to:

- Generic:
  - `audience_interaction_draw_start`, with `sceneId`, `componentType`, `drawId`, `durationSeconds` and the shuffled `songIds`.
  - `audience_interaction_draw_end`, when the draw timer completes, alongside `scene_update`.
- Legacy, unchanged:
  - `modoitaliano_bracket_draw_start`
  - `modoitaliano_bracket_draw_end`

Consumers can move to the generic events at their own pace.

## Song chart identity

### Persistence (`SongChartIdentity`)
An additive table, one row per song, holds a song's chart identity independently of any one provider:

```prisma
model SongChartIdentity {
  id         Int      @id @default(autoincrement())
  songId     Int      @unique
  song       Song     @relation(fields: [songId], references: [id], onDelete: Cascade)
  provider   String
  externalId String?
  rank       String?
  spins      String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```

`provider` has no database default. The service writes it as follows:

- When a song is created or updated with any chart value, the row is written with the song's `earone*` values.
- A new row takes the request's `externalChartProvider`, or `earone` when none is sent (the only provider today).
- An update without `externalChartProvider` keeps the stored provider. Only an update that sends a non-blank provider changes it.
- When an update clears every chart value (`earoneSongId`, `earoneRank` and `earoneSpins` all null), the row is deleted, so no stale rank or spins remain.

The migration adds this table only: no `DROP`, no type change, no `NOT NULL` on an existing table. Rollback: `DROP TABLE "SongChartIdentity";`.

### Song response fields
Every song payload (list, detail, create and update) carries both the legacy `earone*` fields (`earoneSongId`, `earoneRank`, `earoneSpins`) and the generic `externalChartId`, `externalChartSongId`, `externalChartRank` and `externalChartSpins`, with equal values. Requests may send either set. Sending `externalChart*` writes the same `earone*` columns.

## Branded chart proxy

`GET /charts/sanremo-realtime` is unchanged and keeps serving. The program page's realtime chart (`frontend/app/utils/earoneRealtime.ts`) still reads it. Retiring it needs that frontend change first, and is a separate follow-up.
