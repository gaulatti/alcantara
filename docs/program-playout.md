# Program Playout API and Song Command Specification

This document specifies the playout commands sent to Palazzo's private API endpoint:
`POST /v1/programs/{programId}/playback/song`

## Song Command Extensions: Segue and Loudness Normalization

Playout commands support optional segue points and loudness measurements derived from media analysis. When absent or when `segueMode` is `off`, the command structure remains identical to the baseline playout payload.

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
