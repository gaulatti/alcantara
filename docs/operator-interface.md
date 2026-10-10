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

## Button help

Alcántara uses the Tooltip from the installed Bleecker component library for
shared Button and IconButton controls, and for styled broadcast buttons, Cartwall
pads, and rundown controls. Help opens on pointer hover or keyboard focus and
closes on Escape. Existing title text is preferred, then the accessible label,
then the visible action label. Native browser titles are removed when Bleecker
renders the help, so there is one tooltip. Bleecker's `asChild` trigger adds no
layout wrapper and preserves the existing action, ref, style, and accessible name.
Disabled native controls remain inert while allowing hover help.

Audio preset tooltips explain their target dB level; Mute, Solo, and Stop all
explain their effect on Program. The `audio` fixture includes these controls;
ordinary Director and Library fixtures exercise the shared buttons.
`/console-fixture?state=button-help` isolates a labeled action, icon action, and
disabled action for keyboard and hover review.

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

TAKE and CUT swap the buses: the prepared Preview scene becomes Program, and
the former Program scene becomes Preview. A second TAKE returns to that scene.
When Program had no scene, Preview becomes empty after TAKE. Both scene IDs are
persisted together and returned in the acknowledgement and `scene_change`
event, so other directors, both confidence monitors, and a page reload see the
same pair. A failed persistence operation leaves both buses unchanged. The
`normal` console fixture supports repeated TAKE/CUT swaps for visual review.

The private Prometheus scrape includes
`alcantara_scene_handoffs_total{result="success|failure|unknown"}` for scene
handoff persistence outcomes. It contains no program or scene identifiers.

Scene preparation opens the component fields first; Background audio is a
separate tab. A hidden component is identified above the editor with an explicit
Show component action. Editing a scene already on Program displays a live-change
warning. The autosave queue releases completed and failed requests so later edits
can persist; failed requests preserve a newer queued edit.

Prepare uses one Bleecker Card with enclosed component Tabs, accessible Fields,
and dedicated Checkbox controls. The selected tab names the component once.
Short forms use their natural height; longer forms scroll within a readable
1120px content width, independently of the Save changes footer. The editor never
shrinks to the leftover height below the switcher. A warning identifies edits
that affect Program; hidden-component warnings belong to the selected tab.
`prepare-clock`, `prepare-error`, and `prepare-saving` console fixtures cover the
clock, slideshow, player, background audio, and save states at desktop and phone
widths. `hidden-component` retains explicit player restoration coverage.

### Section names

Each panel has one name. Radio and TV Audio use **Cartwall** and **Mixer** without
the duplicate “Instant audio” and “Program mix” eyebrows. Playlist, continuous
fillers, and Rundown also omit generic category headings. Recording uses its
disclosure title once; component editors use their tab label once. Labels that
carry separate information remain: Program/Preview, scene identity, Local time,
24/7 operation, event position, locked state, and actual playback/save status.
This is a presentation change; API names and playback behavior are unchanged.

### Radio Program monitoring

The Radio desk embeds Listen, Stop listening, and Monitor volume inside Output
confidence, beside the rundown and Cartwall. The header headphones action and
command palette focus this monitor without opening a new tab or interrupting
listening. From another section they return to the selected station's Radio desk.
Existing `/radio-output/:programId` links select that station and redirect to its
desk. TV and Simulcast retain their TV renderer output action; Renderer Refresh
is hidden for Radio.

The player receives the existing station's output through
**Liquidsoap → Icecast → Palazzo backend → Alcántara backend → browser audio**.
Palazzo relays its configured Icecast port and mount through the private
`GET /v1/programs/:programId/output/audio` API. Alcántara uses the station's
existing approved Palazzo connection. No DNS lookup, public listener URL, or
operator setup is required. The earlier optional `RadioSettings.listenerUrl`
column/API remains for rollback compatibility but is unused by this monitor.

The authenticated `POST /radio/:programId/monitor-ticket` requires `radio.read`
and returns a station-bound stream path with a 60-second connection window.
`GET /radio/:programId/monitor-audio` validates that grant on every request.
Native media can probe and reconnect using the same URL: authorization remains
valid while a stream is connected and for 30 seconds after the last disconnect.
Expired, missing, or wrong-station grants return 401 without contacting Palazzo.
These process-local grants require the existing single backend instance; a
backend restart invalidates them. Long-lived login tokens and private control
URLs never enter the audio element.

The player prepares authorization before the click so native play stays inside
the Safari user gesture. While stopped it renews five seconds before the
producer's expiry and on returning to a visible tab. An expired idle grant is
replaced before issuing a media request; press Listen again when ready. Playback
never refreshes or replaces its source. Listen is disabled while preparing;
connection errors offer Retry connection.

Listen starts only on a click. Stop listening, changing station, and leaving the
page close the browser, Alcántara, and Palazzo stream connections. Bytes are
forwarded incrementally with backpressure; no backend buffers the entire live
stream. Responses disable caching/proxy buffering and preserve the audio content
type. The live stream advertises `Accept-Ranges: none` and returns 200
for range requests because its audio has no fixed byte length. Monitor volume
changes only local audio; no playback/mixer commands are issued. Icecast encoding/buffering still adds delay. This checks the Icecast
output, while the desk's engine confidence remains a pre-Icecast level signal.
`radio-monitor` now shows the complete Radio desk with an inline local audio
fixture; every Radio desk fixture includes these controls.

Workspace options contains presets, keyboard shortcuts, touch mode, fullscreen,
and source-list width. Program recording is a secondary disclosure and contacts
Alana only while open. Recording service availability is independent of scene
staging and TAKE.

The Radio desk has one persistent player at the bottom with actual engine metadata, progress, and remaining time. Continuous fillers retain Manual/Autoplay/Shuffle/Loop and the saved songs. A future published block does not hide the playing rotation. When a timed block is on air, the desk shows its events and routes transport to Stop/Advance through flight execution.

The dominant panel follows the current playout owner. Continuous mode shows the saved filler rotation and existing Play Next overrides; timed mode shows the on-air block with protected played/on-air events and fixed boundaries. **Prepare rundown** opens the planner with the continuous-fillers summary and optional timed blocks. **Build from tags** resolves Library labels into a reviewable block draft. See `radio-station-workflow.md` for selection and completion behavior.

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

## TV Audio desk

The Audio workspace removes the large monitor row and empty explanatory panel.
On wide desktops the desk has three columns: Mixer, music Playlist, and a utility
column containing the compact Program monitor, optional recording disclosure,
and Cartwall. The bottom transport remains the only current-song display.
The playlist and Cartwall scroll independently; neither shares half of a short
column with the other. Cartwall has one search and a visible Stop all action.

Mixer strips expose Music, Cartwall, Scene audio, and Main mix together. Stream
appears when Preview or Program includes a video-stream component, as before.
Vertical keyboard-accessible faders and editable dB values use the existing
console taper and debounced audio-bus persistence. Channel Mute, Solo, saved A/B
levels, and TAKE A/B retain their existing operations. Preset fade is beside the
Mixer heading. Authoritative meters include VU, peak, and hold; Stream shows no
meter because its producer supplies none. Loading disables channel controls;
persistence failure remains visible beside the mixer instead of claiming success.

Below 1280px the monitor and Cartwall move beneath Mixer and Playlist. Below
900px the columns stack, with a bounded playlist. At narrow phone widths mixer
strips wrap into rows. Short windows scroll the workspace while the transport
stays at the bottom; strips never require horizontal scrolling to reach Main mix.
Director and Radio keep their existing layouts and operation paths.

`/console-fixture?state=audio` renders the complete desk with five interactive
fictional mixer channels, twelve songs, and eight Cartwall pads. `audio-empty`,
`audio-loading`, and `audio-error` expose missing-content and persistence states.
Fixture controls do not issue production audio commands.

## Workspaces and ergonomics

- **Director** shows Preview and Program, the source bank, transition, CUT, TAKE,
  and the lower scene-property workspace.
- **Audio** puts the mixer and music playlist in separate working columns, with
  a compact Program confidence monitor above the Cartwall. Radio adds a bounded
  Play Next queue above the playlist;
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

`/flight` is the single Rundown destination in navigation and command search for every show type. Radio opens timed blocks; TV opens operator cues. Simulcast has Timed blocks and Operator cues views inside this workspace. Scheduled sequences are excluded from the operator cue selector, so a published block is not offered as an untimed sequence. Only one sequence can be active per show under the existing backend contract. `/radio-log` redirects to Rundown for existing bookmarks.

Scheduled Rundown preserves tag-based generation, recorded voice tracks, revision checks, preflight, and publication. **Preview fillers** preserves reviewed content and fills gaps from a Library tag before Save and Publish. Song durations come from the catalog; a standalone clip needs its duration entered in seconds. The planner shows gaps, unknown durations, and overruns, and marks generated fillers in both preparation and the live desk. Fixed boundaries cut the last filler; only explicitly authored end boundaries are used. This does not change the separately configured Palazzo recovery playlist.

The console fixtures include `radio-workflow` with filler rows and `rundown-fillers` for the filler selection panel.

### Scheduled Rundown workspace

The block selector and New block action sit above a compact event log. Start, type, event, length, and timing share aligned columns. Fixed starts have a clock marker; other starts are estimates calculated from catalog or declared clip duration, not promises that a track has aired. Unknown durations remain visible. Timing labels describe whether an event fits its boundary; **Check** and **Publish** independently validate audio availability.

Select an event to edit its source, fixed start, clip duration, or voice track in the Event inspector. On phones, selection scrolls to that inspector. The Fillers and Build block tabs keep generation controls available without repeating the sequence or putting a form in every row. Save, Discard, Check, and Publish stay above the log; it scrolls separately with its column headings visible. New block opens a creation dialog, and unsaved edits lock block selection. New events are inserted before an explicit terminal fixed Stop.

Leaving the Fillers or Build block tab while a preview is pending cancels applying its response. A late response cannot replace edits made in the Event inspector or after changing blocks.

`/console-fixture?state=rundown-desk` renders the same workspace with fictional timed news, music, filler cuts, and an unfilled gap. Persistence and publishing are disabled in that fixture. Browser acceptance covers the dense log and inspector at desktop and phone widths, plus source edits, filler preview, Save, and Publish through the normal authenticated local application.

### Continuous radio management

The Radio desk shows the saved continuous filler rotation whenever a timed block is not currently on air, including when future blocks are published. The ordinary transport controls remain connected to that rotation. The Rundown planner keeps a 24/7 continuous-fillers summary above optional timed blocks, with direct access to the live rotation. New blocks can start at any minute and are not forced to end after an hour; offsets, filler previews, duration estimates, and runtime timers follow explicit event boundaries. `/console-fixture?state=radio-continuous` covers a populated rotation with no scheduled blocks. The existing rundown fixture retains its authored +3600 stop to demonstrate compatibility, rather than imposing that boundary on new blocks.
