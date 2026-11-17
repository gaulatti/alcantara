# Program template contracts v2

The broadcast overlay control system manages program state and event dispatching. Visual rendering templates execute externally and communicate with the system via machine-readable contracts and server-sent events.

## Published contract

The v2 contract specifies `kind: alcantara.program-template`, `contractVersion: 2`, and state `schemaVersion: 2`. The full JSON Schema is committed at `docs/contracts/program-template-v2.schema.json`.

A contract v2 manifest declares:

- Template identity, package, bundle version, and relative HTML entrypoint;
- Declared capabilities bounded to the schema enum:
  - `audio.playback`
  - `media.groups`
  - `scene.configuration`
  - `stinger.transitions`
  - `audience.interaction`
  - `data.chart-provider`
  - `source.external-video`
  - `source.webrtc-guest`
  - `sequence.song`
  - `sequence.chyron`
  - `media.slideshow`
  - `display.clock`
  - `display.ticker`
  - `display.scoreboard`
- Control protocol `alcantara.program.v2` over `server-sent-events`;
- Relative snapshot path `state` and events path `events`;
- Runtime query parameter names for `programId` and `apiBaseUrl`;
- Supported signal types matching the allowed signal catalog;
- Optional release files with key, byte count, MIME content type, and SHA-256 digest. As the schema allows, a file entry may carry additional properties; they are accepted and not stored.

A capability or signal outside these lists (for example one a newer template
declares before Alcantara supports it, or a v2-only signal in a v1 manifest)
does not refuse the registration (gaulatti/ariston#217). Alcantara leaves it
out of the stored manifest, so a template is only ever sent signals Alcantara
knows, and counts it in
`alcantara_program_template_unknowns_ignored_total{member}` with `member`
`signal` or `capability`. In the same way, a v2 manifest property Alcantara
does not know, at the top level, in `control` or in
`control.runtimeParameters`, is not read, not stored and not passed to the
template (only `programId` and `apiBaseUrl` ever are); it counts once per key
as `property`, `control-property` or `runtime-parameter`. All five series are
exposed from 0 and the unknown name is never a label. A manifest whose
remaining signals do not include `program_state_snapshot` is still refused, as
are a missing or invalid known member, an unknown `kind`, `contractVersion` or
`schemaVersion`, malformed or duplicated names, and every path, origin,
integrity and size check.

A v2 registration receives state `schemaVersion: 2` on the `program_state_snapshot` event, on every projected state (`GET /program/:programId/state` and state-bearing signals) and on every projected signal. A v1 registration continues to receive `schemaVersion: 1`.

### Broadcast settings in the projected state

While the program-wide broadcast time override is on (`timeOverrideEnabled: true`), a v2 registration's projected state carries an optional `broadcastSettings`, so a page opened mid-override shows the overridden time at once instead of waiting for the next `broadcast_settings_update`:

- It has exactly the shape of that event's `settings` (including `timeOverrideEnabled`, `timeOverrideStartTime`, `timeOverrideStartedAt` and the resolved mixer fields).
- It appears on the `program_state_snapshot` event, on `GET /program/:programId/state`, and on the state of later state-bearing signals in the same event stream. The stream keeps it in step with the `broadcast_settings_update` events it delivers.
- While the override is off the field is absent (not `null`). A v1 registration never receives it.
- The field is additive: a template that does not read it is unaffected. A reader should prefer the latest `broadcast_settings_update` it has received, then `state.broadcastSettings`, then no override.

### Playing track in the projected state

A v2 registration's projected state carries an optional `playingTrack`: the song the radio engine has confirmed on air. Show it when it is present, and otherwise show the sequence as before.

```json
"playingTrack": {
  "playbackId": "0f9c3b4e-…",
  "title": "Track title",
  "artist": "Artist name",
  "startedAt": "2026-11-17T12:00:00.000Z",
  "coverUrl": "https://cdn.example.test/covers/track.jpg"
}
```

- `playbackId` is the engine's playback request id for this play. `title` and `artist` are the values the as-run log records, so either can be `null` when Palazzo reported none. `startedAt` is when the engine accepted the start. For a play adopted after a reconnect it is Palazzo's reported start time.
- The source is the engine's accepted `track.started` and `track.ended` events, the same events that feed the as-run log. Sending a song command does not put the song on air; Palazzo's accepted start does. An announced next song (gaulatti/palazzo#40) appears only once its own start is accepted. That includes the overlap case, where it starts under the song it follows; the earlier song's later end then changes nothing.
- The field is absent (not `null`) when nothing confirmed is playing: before the first start, and after a natural end, an operator stop, a manual cut (`replaced`) or a preempted announced song, until the next accepted start. A song Palazzo could not load never appears.
- It appears on the `program_state_snapshot` event, on `GET /program/:programId/state`, and on the state of later state-bearing signals in the same event stream, so a page loaded mid-song starts with it.
- Each change is also sent as a `playing_track_update` signal, which carries `playingTrack` while a track is on air and omits it once the track has ended. The signal is v2-only and is delivered only to manifests that list `playing_track_update` in `control.signals`.
- The field is additive. A template that does not read it is unaffected, and a v1 registration never receives it.
- `coverUrl` is optional (gaulatti/alcantara#179).
  - When a start is accepted, Alcantara looks up the catalogue song whose audio URL matches the accepted track and takes the cover URL stored on that song record, unchanged.
  - It is included only when it is a well-formed `https` URL without credentials and with a public host: a public IP address, or a dotted name that is not under `.localhost`.
  - It is omitted (absent, not `null`) when there is no matching song record, the record stores no cover, the stored value is anything else (such as `http`, malformed, loopback, private, link-local or otherwise reserved addresses, or a bare hostname), or the lookup fails.
  - The field never carries an internal or private address.
- Manual picks of songs outside the catalogue get no `coverUrl`: there is no song record to read one from.
- Each lookup is counted in `alcantara_program_playing_track_cover_lookups_total{result}`, where `result` is `included`, `absent`, `rejected` or `error` (see `docs/program-realtime.md`).
- This differs from the now-playing publisher's order, which prefers the cover supplied with the playback and falls back to the song record. The playing track uses only the stored song record because it is the one authoritative public value. A supplied or Palazzo-reported cover is not used.

## Signals and event projection

For contract v2 registrations, the event stream (`GET /program/:programId/events`) projects signals according to the v2 specification:

| Signal | Projected fields |
| --- | --- |
| `chyron_update` | `sceneId`, `chyronText` |
| `fade_to_black` | `active` |
| `song_playback_active` | `songId`, `title`, `artist`, `coverUrl`, `durationMs`, `startedAt`, `externalChartProvider`, `externalChartRank`, `externalChartSpins` |
| `song_playback_update` | `songId`, `positionMs`, `durationMs` |
| `song_queue_update` | `items: [{songId, title, artist}]` |
| `audio_levels` | `rms`, `peak` |
| `playing_track_update` | `playingTrack` (absent when nothing confirmed is playing), `updatedAt` |
| `audience_interaction_draw_start` | `sceneId`, `componentType`, `drawId`, `durationSeconds`, `candidateIds`, `slot: {matchId, field}` |
| `audience_interaction_draw_end` | `sceneId`, `componentType`, `drawId`, `selectedId` |

`candidateIds` is always present on `audience_interaction_draw_start`: it lists the draw's candidate song IDs in the order drawn (the scenes service broadcasts them as `songIds`), and is an empty list when a draw carries none.

Existing v1 registrations remain supported and unchanged. v2-only signals are projected only for manifests with `contractVersion: 2`.

## Publisher origins and security

Template registration fetches the declared manifest over HTTPS and enforces strict network boundaries:

1. **Approved publisher origins**: In production, manifests must originate from an approved publisher origin. The deployment's runtime secret contract allowlists additional approved publisher origins via `programTemplateOrigins`, a comma-separated list of HTTPS origins. The list is empty by default. In production the secret is the only source: when it omits `programTemplateOrigins`, a `PROGRAM_TEMPLATE_ORIGINS` value left in the container environment is discarded and no additional origin is approved. Outside production, `PROGRAM_TEMPLATE_ORIGINS` in the local environment is used as before.
2. **Origin normalization**: Each configured origin is normalized before it is compared, so `https://Templates.Example.test/`, `https://templates.example.test:443` and `https://templates.example.test` are the same origin. Scheme and host must still match: a different host is refused.
3. **CORS configuration**: The normalized origins in `programTemplateOrigins` are permitted by the API CORS policy.
4. **SSRF protection**: Manifest destinations must resolve only to public network IP addresses. Loopback, private (RFC 1918), link-local, documentation, and multicast ranges are rejected.
5. **Request limits**: Redirects are followed up to three hops, checking each destination. Responses are capped at 256 KiB and must return a JSON content type.

## Rollback

Rollback is immediate and data-driven:
- Emptying the `programTemplateOrigins` secret field prevents new v2 template registrations from custom origins.
- Existing v1 registrations continue operating without modification.
