# Operator interface

Alcántara uses a broadcast-specific variant of the Bleecker application shell.
The shell has one navigation model at every viewport: a persistent sidebar on
desktop, a compact icon rail beside the live console, and a full-height drawer
on phone and tablet. The mobile drawer is above all console surfaces, so a live
monitor or transport control cannot cover navigation.

## Information architecture

Navigation is grouped by operator intent rather than database model:

- **Live** contains the mode-specific desk, Rundown, Radio or Simulcast Clocked logs, Guest calls, and TV
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

The Radio desk puts output confidence, the current clocked log, and the on-air
track before secondary recovery/session and mixer controls. Playlist and Play
Next remain adjacent on desktop and follow the on-air view on small screens.

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
The `state=radio-workflow` fixture renders the Radio desk's current/next log,
output confidence, recovery controls, and compact mixer without commanding
Palazzo.

Browser acceptance covers 1440 x 900, 1024 x 768, and 390 x 844. Verify that
navigation is reachable, no shell element overlaps the switcher, Stage does not
change Program, CUT/TAKE are in the same working viewport, fade-to-black is
deliberate, and Radio/TV/Simulcast each expose the correct operational surface.
