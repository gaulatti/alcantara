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

`GET /charts/sanremo-realtime` is unchanged and keeps serving. Removing it is a separate follow-up (second part of #165).

### Generic chart feed
`GET /charts/realtime` serves the same refreshed entries as the proxy in a provider-neutral shape, one object per entry:

```json
{ "provider": "earone", "externalId": "501", "title": "Cuore", "artist": "Alba", "rank": "1", "spins": "310", "updatedAt": "2026-11-17T09:00:00.000Z" }
```

It is public, like the proxy and the program page's other data routes, because the page runs inside the renderer with no credentials. The feed and the proxy come from the same upstream fetch: `ChartsService` refreshes EarOne and ESCplus every 15 seconds, once, and both routes read that one cache. `provider` is `earone` for entries EarOne ranks and `escplus` for entries only ESCplus lists. ESCplus-only entries have no `externalId`, rank or spins. `updatedAt` is the time of the refresh that produced the values; when the upstream fails, the last good entries stay in place with their old `updatedAt`. The proxy's `spotifyPlays`, `youtubeViews` and `youtubeLikes` are not in the feed, because the program page never reads them.

Each refresh also writes the upstream `rank` and `spins` into every `SongChartIdentity` row whose `provider` is `earone` and whose `externalId` is the entry's EarOne id. Only changed, non-null values are written, so a refresh never clears a rank. A failed write is logged and counted as `alcantara_dependency_operations_total{dependency="postgres",operation="write",result="failure"}`; the refreshed cache still serves. Saving a song in the songs page copies its typed `earone*` values back into its `SongChartIdentity` row (`SongsService.syncChartIdentity`, unchanged), so a saved song shows its typed values until the next refresh, at most 15 seconds later.

The program page polls the feed every 15 seconds while a scene shows the chart component (`loadChartLookup` in `frontend/app/utils/chartFeed.ts`). It calls the proxy (`fetchEaroneRealtimeLookup` in `frontend/app/utils/earoneRealtime.ts`) only when the feed does not answer, answers with an error, or does not return a list. Feed and proxy entries are matched by one function (`matchChartEntry`): by chart id, else by the chyron text normalized to the entry's artist-and-title key. A song with no generic fields shows exactly what it showed before, because the feed's rank and spins are refreshed from the same upstream on the same timer as the proxy's.

### Program page chart values
The program page's chart component takes rank and spins from the active chyron song. Each value is chosen on its own, taking the first one present (`resolveChartDisplay` in `frontend/app/utils/programChartValues.ts`):

1. The scene's explicit `rank` or `spins` prop.
2. The song's generic `externalChartRank` or `externalChartSpins`.
3. The realtime chart entry's rank or spins, from the generic feed or, when it is unavailable, the proxy.
4. The song's legacy `earoneRank` or `earoneSpins`.

The realtime entry is found by the song's `earoneSongId`, else its `externalChartId`, else its `externalChartSongId`, else by the song text. A song without generic fields therefore shows exactly what it showed before; a song with only one generic value takes the other from the realtime entry. `externalChartProvider` is not read: the component's label stays the scene's `label` prop, or its default.
