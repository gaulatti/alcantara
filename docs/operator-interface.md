# Operator interface

Alcántara uses a broadcast-specific variant of the Bleecker application shell.
The shell has one navigation model at every viewport: a persistent sidebar on
desktop, a compact icon rail beside the live console, and a full-height drawer
on phone and tablet. The mobile drawer is above all console surfaces, so a live
monitor or transport control cannot cover navigation.

## Information architecture

Navigation is grouped by operator intent rather than database model:

- **Live** contains the mode-specific desk, one Rundown workspace, Guest calls, and TV
  destinations where applicable.
- **Library** contains Scenes and Scene templates for visual shows plus one
  Media destination for every show type. TV and Simulcast Media is organized by
  Images, Audio, Video, and Labels; Radio exposes only Audio and Labels. Audio
  capabilities distinguish songs, instant audio, and scene backgrounds without
  splitting them into separate libraries.
- **Show setup** contains Shows and, for Radio or Simulcast, Radio distribution.

The selected Show is the shell's operating context. Its `tv`, `radio`, or `both`
type changes the available destinations and the live desk label. A Radio show
gets the Radio desk. A TV show gets the TV control. Simulcast keeps the TV
switcher and adds an explicit radio-leg rail: scene actions affect TV, while
songs and audio clips use the shared program mix.

Images, audio clips, songs, and transition videos share the canonical asset
identity described in [Media library architecture](media-library-architecture.md).
Labels classify any media and optionally order its use. The separate Songs,
Audio clips, Transitions, and media-group routes remain compatibility editors,
but navigation and normal discovery begin in the unified Media library.
Label selectors create and select a new label inline, including image upload,
background-audio upload, and bulk labeling, so classification does not require
a round trip through the Labels tab.

Radio is an audio-only show type. Its setup form exposes no renderer template,
Scenes, Media groups, or Transitions, and the backend rejects those visual
assignments even when called outside the browser. Changing an existing show to
Radio removes any obsolete visual assignments atomically. Simulcast remains the
explicit type for a shared TV and radio program.

## Control grammar

Ordinary actions use Bleecker buttons and controls. Surface hierarchy uses the
shared Bleecker page, card, panel, border, radius, typography, and theme tokens.
The broadcast deck reserves a separate semantic action grammar:

- **Stage** selects Preview only.
- **CUT** and **TAKE** are the only controls that move Preview to Program.
- **FADE TO BLACK** requires an arm action followed by confirmation within three
  seconds. Restoring Program remains a single explicit action because it removes
  the blackout.
- Red/destructive styling is reserved for a destructive or live-impacting
  action. Icon-only controls always have a visible tooltip or accessible label.

The command palette follows the same safety boundary. A scene command stages
the scene; it never activates Program directly.

## Live desk flow

The Director desk reads left to right: **Sources → Preview → Program**.
Sources has a searchable, vertically bounded scene list and explicit Preview and
Program labels. Selecting a source stages it without changing Program. CUT and
TAKE sit directly beneath both monitors, with the selected transition and the
name of the prepared scene. A pending TAKE disables both actions; a failed save
or activation shows an error beside them and does not claim the scene is live.
TAKE waits for staging and scene autosave, then consumes the backend's
acknowledged Program state.

Scene preparation opens the component fields first; Background audio is a
separate tab. A hidden component is identified above the editor with an explicit
Show component action. Editing a scene already on Program displays a live-change
warning. The autosave queue releases completed and failed requests so later edits
can persist; failed requests preserve a newer queued edit.

Workspace options contains presets, keyboard shortcuts, touch mode, fullscreen,
and source-list width. Program recording is a secondary disclosure and contacts
Alana only while open. Recording service availability is independent of scene
staging and TAKE.

The Radio desk has one persistent player at the bottom, keeping artwork,
reported track metadata, progress, remaining time, and log transport together.
It remains visible on phones and displays the actual on-air track. **Start log**,
**Stop log**, and **Advance** use flight/log execution; there are no radio
playlist modes or loop controls. Start is available for a published, unaired
hour; it respects the scheduled start rather than playing early.

The dominant **On-air log** shows the entire selected hour with event times,
catalog metadata, duration, voice-track indicators, and NOW/NEXT/PLAYED markers.
**Play next**, up/down, remove, and Library insertion persist changes to this
same log at its expected revision. Played/on-air events stay locked, and moving
an event cannot cross a fixed-time boundary. **Prepare hours** opens the log
planner; **Build from tags** resolves Library labels into a reviewable draft.
See `radio-station-workflow.md` for selection rules and publish behavior.

Output confidence, Cartwall, and the three-channel Mixer remain beside the log.
The Cartwall has search, numbered pads, existing shortcut labels, and playing
state. Disabled clips stay disabled. Recovery/session controls remain in a
secondary disclosure. The development `radio-workflow` fixture now shows a log
with both following events and fixed-time boundaries; `radio-empty`,
`radio-offline`, and `radio-external` retain explicit empty/degraded feedback.

The local wall clock is labeled separately from authoritative playback timing.
Remaining time uses reported duration and position; stale telemetry is labeled
as last reported time. Missing output/engine data stays visibly unverified or
unavailable. The console does not generate a simulated waveform or audio meter.

Console surfaces retain Encode Sans, Bleecker radii, and the existing palette,
with centrally scoped dark surface and semantic live/preview/ready tokens in
`BroadcastConsole.css`. This fixed dark working surface keeps monitor and status
contrast consistent in both shell themes. Focus outlines remain visible and
reduced-motion preferences disable console animations. Preview and Program use
small colored headers and larger monitor surfaces; numbered Sources remain
directly adjacent to CUT/TAKE.

The layout is informed by the official PlayoutONE, mAirList, Zetta, Rivendell,
and Myriad product imagery: dense logs, persistent transport, adjacent cartwalls,
and strong current/next hierarchy. The inspected Myriad operational image was
the older Remote v5 view; it is not presented as a Myriad 6 screen.

Public Program renderers do not load authenticated operator preferences. Console
preferences belong to the protected operator workspace. Startup and authentication
checks share the branded, accessible loading view.

## Workspaces and ergonomics

- **Director** shows Preview and Program, the source bank, transition, CUT, TAKE,
  and the lower scene-property workspace.
- **Audio** shows Program confidence plus the mixer, playlist, sounders, and
  playback controls. Radio adds a bounded Play Next queue above the playlist;
  playlist-row actions enqueue without interrupting the current song, and the
  queue returns to normal playlist order after it drains. A separate star
  marks up to 12 playlist songs for High Rotation and shows the current count;
  the thirteenth star is disabled and the backend enforces the same limit.
- **Remote** is the bounded switcher used on compact devices. It removes the
  lower editor without removing staging or live actions.

On phone, Preview and Program remain adjacent, followed by the source bank and
then CUT/TAKE. The operator does not need to scroll past the switcher, choose a
source, then return to TAKE. Collection routes use stacked cards with visible
actions where a desktop row would otherwise require horizontal navigation or
hover.

## Local verification fixtures

Compose seeds three fictional shows: `main` (Simulcast), `tv-demo` (TV), and
`radio-demo` (Radio). It also seeds two scenes, songs, audio clips, a media group,
a disabled transition example, radio settings, a disabled now-playing consumer,
and a type-appropriate Rundown for each show. This data is intentionally local
and non-sensitive.

The development-only `/media-fixture` demonstrates the Radio-scoped Audio and
Labels tabs, unified audio cards, capability badges, and inline label creation.
`/console-fixture` supports `state=normal`,
`state=empty-preview`, `state=on-air`, `state=disconnected`, `state=ftb`,
`state=audio`, `state=remote`, `state=taking`, `state=take-failed`, and
`state=loading`, and `state=hidden-component`. Add `mode=both` to exercise the Simulcast
status rail. Production builds do not expose the fixture route.

Playback control states are available at `state=playback-live` and
`state=playback-stale`. These fixtures show the mutually exclusive Manual,
Autoplay, and Shuffle modes, the independent Loop state, and the live/stale
authoritative feedback indicator without commanding Palazzo.
The `state=play-next` fixture renders the ordered queue, active queued entry,
and safe queue controls without commanding Palazzo. The
`state=high-rotation` fixture renders the favorite count, selected star, and
limit-aware playlist controls without commanding Palazzo.
The `state=radio-workflow` fixture renders a populated twelve-track Radio desk,
full clocked log, output confidence, Cartwall, and Mixer without commanding
Palazzo. Queue changes, cart triggers/search, mute/fader controls, and Stop are
interactive in this fixture. `state=radio-empty`, `state=radio-offline`, and
`state=radio-stale` cover the corresponding explicit states.
`state=radio-external` keeps the reported playing track visible when it is absent
from the playlist. These fixtures are
visual verification only; normal authenticated Compose console checks exercise
the actual backend staging, activation, queue, and mix paths separately.

Browser acceptance covers 1440 x 900, 1024 x 768, and 390 x 844. Verify that
navigation is reachable, no shell element overlaps the switcher, Stage does not
change Program, CUT/TAKE are in the same working viewport, fade-to-black is
deliberate, and Radio/TV/Simulcast each expose the correct operational surface.

## Unified Rundown

`/flight` is the single Rundown destination in navigation and command search for every show type. Radio opens scheduled hours; TV opens operator cues. Simulcast has Scheduled hours and Operator cues views inside this workspace. Scheduled sequences are excluded from the operator cue selector, so a published hour is not offered as an untimed sequence. Only one sequence can be active per show under the existing backend contract. `/radio-log` redirects to Rundown for existing bookmarks.

Scheduled Rundown preserves tag-based generation, recorded voice tracks, revision checks, preflight, and publication. **Preview fillers** preserves reviewed content and fills gaps from a Library tag before Save and Publish. Song durations come from the catalog; a standalone clip needs its duration entered in seconds. The planner shows gaps, unknown durations, and overruns, and marks generated fillers in both preparation and the live desk. Fixed boundaries cut the last filler; the generated end-of-hour Stop is at +3600 seconds. This does not change the separately configured Palazzo recovery playlist.

The console fixtures include `radio-workflow` with filler rows and `rundown-fillers` for the filler selection panel.

### Scheduled Rundown workspace

The hour selector and New hour action sit above a compact event log. Start, type, event, length, and timing share aligned columns. Fixed starts have a clock marker; other starts are estimates calculated from catalog or declared clip duration, not promises that a track has aired. Unknown durations remain visible. Timing labels describe whether an event fits its boundary; **Check** and **Publish** independently validate audio availability.

Select an event to edit its source, fixed start, clip duration, or voice track in the Event inspector. On phones, selection scrolls to that inspector. The Fillers and Build hour tabs keep generation controls available without repeating the sequence or putting a form in every row. Save, Discard, Check, and Publish stay above the log; it scrolls separately with its column headings visible. New hour opens a creation dialog, and unsaved edits lock hour selection. New events are inserted before a terminal +3600 Stop.

`/console-fixture?state=rundown-desk` renders the same workspace with fictional timed news, music, filler cuts, and an unfilled gap. Persistence and publishing are disabled in that fixture. Browser acceptance covers the dense log and inspector at desktop and phone widths, plus source edits, filler preview, Save, and Publish through the normal authenticated local application.
