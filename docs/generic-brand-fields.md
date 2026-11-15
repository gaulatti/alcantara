# Generic Audience Interaction and Chart Identity

This document covers the generic brand decoupling for audience interaction brackets and song chart identity in Alcantara, controlled by the per-program `genericBrandFields` setting.

## Configuration

The flag is stored as a nullable boolean column on `ProgramState`:

```prisma
model ProgramState {
  // ...
  genericBrandFields Boolean? @default(false)
}
```

- **Default (Off / `false` / `null`)**: Alcantara operates in backward-compatible mode. API payloads and event broadcasts remain byte-identical to legacy behavior.
- **Enabled (`true`)**: Decouples customer/branded identifiers, emits generic audience interaction events, exposes generic chart identity fields, and retires branded chart proxies.
- **Rollback**: Set `genericBrandFields` to `false` or `null`.

## Generic Audience Interaction Brackets

### Component Support
When `genericBrandFields` is enabled, scenes whose layout `componentType` matches any bracket or audience interaction component (such as `harbor-light-bracket` or `*.audience.interaction`) are accepted for draw and voting lifecycles.

When the setting is disabled, bracket draw and voting fallback strictly to `modoitaliano-bracket`.

### Realtime Broadcast Signals
During bracket draws (`drawModoItalianoBracket`), when `genericBrandFields` is enabled, the server broadcasts both:
- Generic events:
  - `audience_interaction_draw_start`: Emitted with `sceneId`, `componentType`, `drawId`, `durationSeconds`, and shuffled `songIds`.
  - `audience_interaction_draw_end`: Emitted upon timer completion alongside `scene_update`.
- Legacy events:
  - `modoitaliano_bracket_draw_start`
  - `modoitaliano_bracket_draw_end`

Downstream consumers can migrate to the generic event names while existing clients continue to receive legacy event payloads.

## Song Chart Identity

### Persistence (`SongChartIdentity`)
An additive table `SongChartIdentity` links 1:1 with `Song` to decouple third-party chart providers:

```prisma
model SongChartIdentity {
  id         Int      @id @default(autoincrement())
  songId     Int      @unique
  song       Song     @relation(fields: [songId], references: [id], onDelete: Cascade)
  provider   String   @default("earone")
  externalId String?
  rank       String?
  spins      String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```

### Generic Song Response Fields
When `genericBrandFields` is enabled for the program or environment:
- Song payloads carry both `earone*` (`earoneSongId`, `earoneRank`, `earoneSpins`) and generic `externalChart*` (`externalChartSongId`, `externalChartRank`, `externalChartSpins`) fields with equal values.
- Creating or updating songs with `externalChart*` fields synchronizes both the legacy song columns and the `SongChartIdentity` record.

When disabled:
- Song responses emit only the legacy `earone*` fields, preserving exact byte-identical API outputs.

## Retirement of Branded Chart Proxy

`GET /charts/sanremo-realtime` previously proxied third-party endpoints. Under `genericBrandFields`:
- When `genericBrandFields` is enabled: Responds with `404 Not Found` (`Sanremo realtime chart proxy is retired`).
- When `genericBrandFields` is disabled: Maintains proxy functionality for legacy clients.
