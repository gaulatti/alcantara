# Program Playout API and Song Command Specification

This document specifies the playout commands sent to Palazzo's private API endpoint:
`POST /v1/programs/{programId}/playback/song`

## Song Command Extensions: Segue and Loudness Normalization

Playout commands support optional segue points and loudness measurements derived from media analysis. When absent or when `segueMode` is `off`, the command structure remains identical to the baseline playout payload.

### `segueMode` is a per-program setting, on by default

`RadioSettings.segueMode` accepts `on` or `off` (anything else is rejected with 400). A radio settings row created without a `segueMode` gets `on`: both the column default (migration `20261117000000_radio_segue_mode_default_on`) and the radio service's create path use `on`. An operator can still set `off` for a program, and an update that does not name `segueMode` leaves the stored value alone.

That migration changes only the column default. It does not rewrite existing rows, so a program whose settings row existed before it keeps its stored value; rows created by the earlier `20261115000000_radio_segue_mode` migration were stored as `off`.

Migration `20261120000000_radio_segue_mode_on_for_existing` (gaulatti/alcantara#180) then turns it on for existing radio programs. For every radio program (`ProgramState.type` `radio` or `both`), a `RadioSettings` row whose `segueMode` is not `on` keeps its previous value in the nullable column `segueModeBeforeDefaultOn` and is set to `on`; a row already `on` keeps a null there. TV programs, and programs without radio settings, are not touched. The migration is additive and repeatable: a row that already recorded a previous value is never rewritten. The stored data could not tell an operator's `off` from the old default, because no operator screen sets `segueMode`, so every `off` row was turned on. `GET /radio/:programId/settings` returns the new column with the rest of the row.

To put the previous values back, ship a forward migration with `UPDATE "RadioSettings" SET "segueMode" = "segueModeBeforeDefaultOn" WHERE "segueModeBeforeDefaultOn" IS NOT NULL AND "segueMode" = 'on';`. The `"segueMode" = 'on'` condition leaves alone any program an operator has turned off since.

**Operator note:** to turn segue, loudness and gapless handoff off for one program, send `PUT /radio/:programId/settings` with `{"segueMode": "off"}`.

With `segueMode` on, a song that has no analysis (no media asset, no analysis row, an analysis that is not `success`, or one without measurements) gets exactly the command it would get with `segueMode` off, so it plays as before.

### Pinned JSON Payload Shape

```json
{
  "song": {
    "programId": "radio-1",
    "playbackId": "req-12345",
    "url": "https://media.example/songs/track01.mp3",
    "title": "Song Title",
    "artist": "Artist Name",
    "coverUrl": "https://media.example/covers/track01.jpg",
    "segue": {
      "cueInSeconds": 0.35,
      "cueOutSeconds": 211.0,
      "fadeInSeconds": 0.0,
      "fadeOutSeconds": 1.8,
      "overlapSeconds": 2.5
    },
    "loudness": {
      "integratedLufs": -9.8,
      "truePeakDbtp": -0.4
    }
  },
  "intro": {
    "programId": "radio-1",
    "playbackId": "req-12345:intro",
    "url": "https://media.example/intros/station-id.mp3",
    "gain": 1.0,
    "duckGain": 0.3,
    "fadeInSeconds": 0.2,
    "fadeOutSeconds": 0.5
  }
}
```

### Validation Rules

Before sending any command to Liquidsoap, the payload is validated strictly:

1. **Finite Numbers**: All numeric fields in `segue` (`cueInSeconds`, `cueOutSeconds`, `fadeInSeconds`, `fadeOutSeconds`, `overlapSeconds`) and `loudness` (`integratedLufs`, `truePeakDbtp`) must be finite numbers.
2. **Cue Bounds**:
   - `0 <= cueInSeconds < cueOutSeconds`
   - If duration is defined: `cueOutSeconds <= duration`
3. **Fade Bounds**:
   - `fadeInSeconds >= 0`
   - `fadeOutSeconds >= 0`
4. **Overlap Bounds**:
   - `overlapSeconds >= 0`
   - `overlapSeconds <= cueOutSeconds - cueInSeconds`
5. **Loudness Bounds**:
   - `loudness.integratedLufs >= -70` and `loudness.integratedLufs <= 0`
   - `loudness.truePeakDbtp <= 6`

If any validation rule fails, the client immediately rejects the command before issuing any Liquidsoap transition or network call, throwing `PalazzoMachineError('rejected')`.

### Analysis never takes a song off air

The rules above are enforced by `PalazzoMachineClient` (`validateSongSegue` and `validateSongLoudness` in `backend/src/radio/palazzo-machine.client.ts`). A rejected command would take the song off air, so with `segueMode` on the radio service applies the same checks first, using those same functions so the bounds cannot drift. It does this per field group, before it builds the command:

- **Invalid segue** (bad cue, fade or overlap values) is dropped. The song plays without it, and any valid loudness is still sent.
- **Invalid loudness** (integrated loudness outside −70 to 0 LUFS, true peak above +6 dBTP, or a non-finite value) is dropped. The song plays without it, and any valid segue is still sent.
- **Cue-out beyond the song's duration** drops the segue. The duration is the caller's, else the song's stored `durationMs`. A song with no stored duration is not bounded.
- **An audio URL shared by more than one song**: when the command does not name the song, no analysis is applied. The lookup needs exactly one song with that URL.

When both groups are dropped, the command is byte-identical to the `segueMode`-off command.

Each drop increments `alcantara_radio_analysis_dropped_total{result=...}`. `result` is one of `segue-invalid`, `segue-beyond-duration`, `loudness-invalid` or `ambiguous-match`, and there are no song or program labels. Each song with any drop is logged once as `radio.song_analysis_dropped`, with `programId`, `playbackRequestId`, `songId` when known, and the list of reasons. The audio URL is never logged.

## Next-song announcement (`PUT`/`DELETE …/playback/next`)

Contract: gaulatti/palazzo#40 §1. While a song plays, the engine may announce the song it expects to play next with `PUT {palazzoUrl}/v1/programs/{programId}/playback/next`, `Idempotency-Key: <playbackId>`, and the body `{ "song": … }`: the song command's `song` object unchanged, with no `intro`. `segue` and `loudness` are resolved and validated exactly as for the song command, and only when `segueMode` is on. `PalazzoMachineClient.announceNext` maps the answers: 200 `{ok, playbackRequestId, state: "queued"}` is accepted (with `duplicate` on a repeat); 409 and 400 are "not announced"; 422 is not ready; 404 is an older Palazzo, which then gets no announcements until its boot changes. `DELETE` withdraws it (`PalazzoMachineClient.withdrawNext`). The song command itself is unchanged: a command without an announcement is byte-identical to before. See [radio-station-workflow.md](radio-station-workflow.md) for when the engine announces, withdraws and promotes.
