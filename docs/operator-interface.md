# Operator interface

Alcántara uses a broadcast-specific variant of the Bleecker application shell.
The shell has one navigation model at every viewport: a persistent sidebar on
desktop, a compact icon rail beside the live console, and a full-height drawer
on phone and tablet. The mobile drawer is above all console surfaces, so a live
monitor or transport control cannot cover navigation.

## Information architecture

Navigation is grouped by operator intent rather than database model:

- **Live** contains the mode-specific desk, one Rundown workspace, Guest calls,
  External sources (the managed video sources of the show, with a preview that never
  reaches Program; #45) and TV destinations where applicable. Guest calls and
  External sources appear only for a show with a television leg.
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
- **Fade to black** is a Bleecker `ArmTake`: the first press only
  arms it, a second press within five seconds or
  a 0.8-second hold takes it, and Esc disarms. From the keyboard, Alt+B arms and
  a second Alt+B within three seconds takes it; a "Fade to black armed" pill
  shows while it waits. Restoring Program remains a single explicit action
  because it removes the blackout.
- Program shows its state as a Bleecker `StatePill` in the monitor header: **On
  air** (pulsing, with the on-air glow on the monitor) or **Faded to black**.
  Preview carries no on-air state. Source rows use pills too: Program, Preview ·
  Program, or Preview.
- The transition, device class and preset visibility pickers are Bleecker
  `Select`; the source panel width is a Bleecker `Slider`. No text on the deck
  is smaller than 12 px.

Keyboard shortcuts apply when the keyboard toggle in Workspace options is on. Only a fresh key press acts: a held key's repeats are ignored, so holding Alt+B arms and never takes.

| Action | Mouse | Keyboard |
|---|---|---|
| Take Preview to Program | TAKE TO PROGRAM | Space |
| Cut | CUT | C |
| Clear Preview | — | Esc |
| Fade to black | Fade to black twice within 5 s, or hold 0.8 s | Alt+B twice within 3 s |
| Restore Program | RESTORE PROGRAM | — |
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

### Program return and the caller desk

The PREVIEW and PROGRAM monitors are the program page rendered again in the
director's own browser (`?confidence=preview|program`), and PROGRAM is silent
(output gain 0). Neither is the output: they have no latency, no signal loss
and no audio. Both headers say `local render`, PROGRAM carries a
"Local render · not the output" ribbon, and its Listen action is disabled with
the reason (alcantara#301). `ConfidenceMonitor` also takes a `returnSource` for
a real return (from Alana or the Tauri pilot), which does not exist yet. When
one does, the tile shows "Return · from <source>", how far it is behind, and
one of Live, Delayed (more than 3 s behind), Frozen (the same frame for 2 s,
with a timer) or Signal lost (filling the tile, with the time since the last
frame). These thresholds are the proposal's, for the owner to set, and are not
stored. TAKE and CUT never wait on the return.

Guest calls is a caller desk. A status strip counts the guests sent the live cue
and the slots in use. A waiting list shows invited guests who have not joined,
and each of the six slots is a strip with the guest's connection, return video
and bus, level, delay, mute, camera, cue, private message, replace, remove and
revoke. The strip says "Cued live" only for the last cue the console sent. A
guest reaches the output only through a scene that carries them, and the strip
says so. Talk is hold-to-talk (press and hold, or hold T while the strip has
focus). Releasing always closes the microphone, even before the connection is
up. Talking to a guest who was cued live needs "Allow talk while cued live" to
be ticked first. The live cue is armed by one press and sent by a second press,
or by Space within 5 s. The wrap cue needs a 0.8 s hold. Screening before air,
a per-guest on-air state and mic meters are not built yet, and the desk says
so. Without LiveKit (alcantara#51) the page names that dependency, and a control
plane that can't be reached is named instead of showing a raw fetch error.

`/console-fixture?state=program-return` draws the tile in each state, today's
local render first. `/console-fixture?state=caller-desk` draws three fictional
strips: cued live, connected and reconnecting.



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

The Radio desk (#298) has an **on-air strip** that never scrolls away: On air, Off air or Status delayed, the song with elapsed and remaining time, the intro state, what plays next and the playout mode, and the stream, engine and monitor chips (Stream verified, Engine ready, Monitor off; an unknown or failed state is never shown as a good one). When the telemetry is stale the strip says Status delayed and shows no clock instead of a frozen one. **On air** means the engine confirmed it (#609): while the playout engine is not connected, a playing song shows **Not confirmed** with no clock, and no rotation row is marked On air. Manual/Autoplay/Shuffle/Loop sit above the rotation, and the song on air and the next one are marked in it. At the bottom, the transport is **Cue next (N)**, then **Take (Space)**: one press never takes, a cue clears itself after five seconds or on Esc, and a refused take is shown beside the transport. After a take the transport shows **Taken** and waits for the engine to confirm the song on air. While the engine is off, the transport says so and **Take is refused** without sending anything (`Engine unavailable: … Nothing was taken.`); the backend refuses the same take with 409 `engine_unavailable` for a radio-only program. Holding **Stop** (or Alt and period) for 0.6 seconds takes the song off air, and holding **Stop all** on the cartwall for 0.6 seconds stops every sounder; a click only explains. **/** opens a search of the rotation and the library: Enter queues a rotation song next, and **Take now** arms it, then **Confirm** within five seconds puts it on air (a library song that is not in the rotation can only be taken, through `POST /radio/:programId/song`, without changing the rotation). **M** toggles the monitor. Sounders show their time left while they play, a cartwall search keeps each pad's number and Ctrl key, and the faders show the live level with its peak and held peak (from `ProgramAudioMeterLevels`) and move one decibel with the arrow keys. Continuous fillers retain the saved songs. A future published block does not hide the playing rotation. When a timed block is on air, the desk shows its events and routes transport to Stop/Advance through flight execution. On a phone (below 768 px) the Radio desk scrolls as one page (#610): the on-air strip stays at the top with its status chips in a single row that scrolls sideways, the transport (or a timed block's playback bar) stays at the bottom, and the rotation, cartwall, mixer and Recovery & session are reached through that one scroll instead of panels that scroll inside each other. Wider screens keep their layout.

The dominant panel follows the current playout owner. Continuous mode shows the saved filler rotation and existing Play Next overrides; timed mode shows the on-air block with protected played/on-air events and fixed boundaries. **Prepare rundown** opens the planner with the continuous-fillers summary and optional timed blocks. **Build from tags** resolves Library labels into a reviewable block draft. See `radio-station-workflow.md` for selection and completion behavior.

Output confidence, Cartwall, and the three-channel Mixer remain beside the log.
The Cartwall has search, numbered pads, existing shortcut labels, and playing
state. Disabled clips stay disabled. Recovery/session controls remain in a
secondary disclosure. The development `radio-workflow` fixture now shows a log
with both following events and fixed-time boundaries; `radio-empty`,
`radio-offline`, and `radio-external` retain explicit empty/degraded feedback.
Cart shortcuts follow the platform (gaulatti/alcantara#308). On macOS a pad plays on Ctrl+letter, and the pad shows that chord. On Windows and Linux a pad plays on Alt+letter, and the pad shows that chord, so Ctrl+C, V, X, Z, A, F and P stay with the browser and the operating system. The platform is read once per page from `navigator.userAgentData.platform`, falling back to `navigator.platform`. Scene hotkeys keep Ctrl+S and Ctrl+digit on every platform. The Windows and Linux letters skip the browser's menu letters: Chrome and Edge use Alt+F, Alt+E and Alt+D, and Firefox's Alt menu uses F, E, V, S, B, T and H. The Alt map is `qyuiopagjzxcm` (13 slots), a subset of the macOS map `qeyuiopadfghjzxcvbm` (19 slots).

A fader move or a playlist, playout-mode or Loop change saves to the program it was made on. Its answer, or
its failure, changes nothing on another program the operator has switched to since (#682).

Failures on the Radio desk are shown, never only logged (#253). A refused
instant or **Stop all** appears above the Cartwall pads and clears when the
next instant or Stop all starts, or when the operator switches program; a
refusal that arrives after a switch is not shown. A song library or Cartwall that did not load
says so with **Retry song library** or **Retry cartwall** instead of looking
empty; a later successful load replaces the error, and only the failed list
shows one. A failed reload never discards a list that already loaded: the
error and its retry sit above the still-usable pads, and stand alone only when
nothing has loaded. Refusals read the server's own `message` when it answers with JSON
(a string or a list of strings), as one line of at most 160 characters and as
plain text; any other body falls back to `HTTP <status>`. The helper is
`frontend/app/utils/responseFailure.ts`. `/console-fixture?state=radio-refused`
shows all three states.

The local wall clock is labeled separately from authoritative playback timing.
Remaining time uses reported duration and position; stale telemetry is labeled
as last reported time. Missing output/engine data stays visibly unverified or
unavailable. The console does not generate a simulated waveform or audio meter.

The program page measures a song or instant from the element's captured stream
when the engine offers `captureStream()`. Otherwise it routes the element through
Web Audio, but only when Web Audio can read the source: same origin, `blob:`,
`data:`, or loaded in CORS mode (`frontend/app/utils/mediaWebAudioAccess.ts`).
A cross-origin source loaded without CORS (the song and instant store sends no
CORS headers) plays on its own element with no measured level. Web Audio would
output silence for it, so routing it would take it off the program sound. This
is the case in WebKit (Safari and the desktop console), which has no
`captureStream()` on media elements.

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

## Program filler

**Broadcast destinations** ends with a **Program filler** section (gaulatti/alcantara#127). It reads `GET /broadcast/programs/:programId/fillers` from #126 (see `docs/program-filler.md` once #126 lands).
- Each leg the program has (television and/or radio) shows its version **Active this session** and its version **Pending next session**. For each version it shows the id, status (with reason), order and seed, sources (named from the media library when known), a short checksum, and the preparation time.
- With `broadcast.manage`, an operator can prepare a television filler from one enabled image or video asset, and a radio filler from enabled audio assets, in order or shuffled with a seed.
- A failed preparation shows the server's message and keeps the selection for a retry.
- Nothing claims a ready state the backend did not report.
- Against a backend without the filler API (404), the section renders nothing.
- No signed URL or credential appears in the UI.

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
`state=radio-stale` cover the corresponding explicit states;
`state=radio-not-configured` shows the engine badge with its reason.
`state=radio-external` keeps the reported playing track visible when it is absent
from the playlist. These fixtures are
visual verification only; normal authenticated Compose console checks exercise
the actual backend staging, activation, queue, and mix paths separately.

`/filler-fixture` renders the program filler legs (gaulatti/alcantara#127): a television leg with an active and a pending version, and a radio leg with a pending shuffle and nothing active. It is built from the response pinned in `app/components/fillerFixture.ts`.

Browser acceptance covers 1440 x 900, 1024 x 768, and 390 x 844. Verify that
navigation is reachable, no shell element overlaps the switcher, Stage does not
change Program, CUT/TAKE are in the same working viewport, fade-to-black is
deliberate, and Radio/TV/Simulcast each expose the correct operational surface.

## Unified Rundown

`/flight` is the single Rundown destination in navigation and command search for every show type. Radio opens timed blocks; TV opens operator cues. Simulcast has Timed blocks and Operator cues views inside this workspace. Scheduled sequences are excluded from the operator cue selector, so a published block is not offered as an untimed sequence. Only one sequence can be active per show under the existing backend contract. `/radio-log` redirects to Rundown for existing bookmarks.

Scheduled Rundown preserves tag-based generation, recorded voice tracks, revision checks, preflight, and publication. **Preview fillers** preserves reviewed content and fills gaps from a Library tag before Save and Publish. Song durations come from the catalog; a standalone clip needs its duration entered in seconds. The planner shows gaps, unknown durations, and overruns, and marks generated fillers in both preparation and the live desk. Fixed boundaries cut the last filler; only explicitly authored end boundaries are used. This does not change the separately configured Palazzo recovery playlist.

The console fixtures include `radio-workflow` with filler rows and `rundown-fillers` for the filler selection panel.

### Recipes (operator cues)

A recipe is the steps a song needs around it: the artist bumper, a transition, a hold, the slideshow for the
song's length and the way back (design note and contracts: gaulatti/alcantara#222, C3). The **Recipes** tab
sits beside **Cues** in the TV and simulcast operator view (`?tab=recipes`), for whoever holds `flight.read`;
only `flight.manage` edits. Radio's timed blocks have no recipes.

- **List:** each recipe with its revision and how many uses it has in this show's operator sequences (the
  distinct `recipeUse.useId` of its cues).
- **Form:** the bumper, slideshow and return scene pickers (the show's assigned scenes; none skips the step),
  the transition, the hold in seconds (0 to 60, half-second steps) and one switch per step. A step switched off
  is left out of `steps`, so the recipe skips it; a step key the editor does not know is kept as it came.
- **Save** sends the revision the recipe was loaded at; the backend compares and sets on it. The confirmation
  first names how many uses that have not aired yet will be rebuilt (uses in a sequence that is not running, and
  uses entirely after the cue on air), including hand edits to them. A 409 shows "Changed elsewhere" with a
  **Reload** button; any other refusal shows its reason.
- **Preview a use:** pick a song and **Preview** calls `POST /program/:id/recipes/:recipeId/expand` with
  `{params: {songId}}` and lists the cues it would write and the issues (`song_unavailable`,
  `artist_label_missing`, `label_empty`, `scene_not_assigned`, `scene_shared`). It uses the saved recipe and
  writes nothing.
- **Empty states:** "Recipes are not available yet" while `GET /program/:id/recipes` answers 404, and "No
  recipes in this show yet" for an empty list.

### Recipe uses in the operator cues (gaulatti/alcantara#425)

The **Cues** tab has the rundown library (search, Songs, Clips; select and press Enter or double-click to
add at the end). When the show has recipes it also has a **Recipes** tab: choose the recipe, pick a song, and
press Enter. The console calls `expand`, and adds the use's cues in one save. When the use reports issues,
a dialog lists them first; **Add anyway** adds it, **Cancel** adds nothing.

- **One row per use:** "Song: *title* · *recipe*", the step count, **On air** while one of its cues is the
  one running. The chevron shows its steps read-only, with the cue on air highlighted.
- **Move up/down** moves the whole use past the neighbouring row (a cue or another use), so a use is never
  split by a move.
- **Change the label** builds the use again with another media label (or the artist's), in place and with
  the same cue ids.
- **Detach** removes the use's tag from its cues; they stay where they are as ordinary cues to edit by hand,
  and the recipe no longer rebuilds them.
- **Remove** deletes all of the use's cues.
- A use split by a hand edit shows as its parts, each marked **Partial use**, offering Detach (not Change
  the label).
- Without recipes on the backend (404) or when they cannot be loaded, there is no Recipes tab and the rest of
  the rundown works as before.

Visual fixture: `/console-fixture?state=rundown-recipe`.

The `rundown-recipes` console fixture shows one recipe with two uses and a preview with one issue.

### Scheduled Rundown workspace

The block is built by direct manipulation (gaulatti/alcantara#299). A searchable **library** (All, Songs, Clips; `/` focuses its search) lists enabled songs with their stored length, enabled clips, and a Stop. Drag a row onto the **timeline**, where it is inserted ahead of the first item whose middle lies past the drop point, or select it (click or ↑/↓) and press Enter, or double-click it, to add it at the end. Nothing is inserted ahead of an item that has played, and an item dropped first becomes the block's opener at 0. Recipes and show templates are not offered until #222's recipe model exists.

The timeline draws the block as a span of time with the numbers `rundownTiming()` computes: each item where it starts and as wide as its stored length, a hatched **gap** where content ends before the next fixed start, and a red **cut** where it runs past one. An item with no stored length is dashed and drawn 30 s wide after the previous item; the starts after it are unknown. Its header totals content, gaps, any content overrun (fillers are cut, not counted as overrun) and how many items have no stored length. Each fixed start (`clockOffsetSeconds`) is a gold pin on the ruler: drag it, or focus it and press ←/→ to move it 5 s (Shift for 60 s). It always snaps to 5 s. The opener's pin and those of played items do not move. The Event inspector's **Pin its start here** fixes an item at its estimated start, and **Follow the previous event** removes the fixed start.

**Advanced** in the Event inspector edits the raw cue parameters the timeline does not draw: voice track clip id, music level under the voice, voice fades, scene id, transition id and the filler flag.

A cue built from a recipe carries its `recipeUse` tag (`useId`, `recipeId`, `recipeRevision`, `step`, `params`): it is kept through save, load and start, so the console can group the cues of one use. A malformed tag is dropped and its cue kept. The resolver and the executor ignore the tag (gaulatti/alcantara#422). Emptying a field removes the parameter. It also shows the cue exactly as stored; `metadataPatch` and `mixerChange` are read only there. The saved flight JSON keeps the shape the forms wrote: the same `FlightCue` fields and nothing new.

**Check & publish** (⌘↵, or Ctrl+Enter) saves unsaved edits, runs Check on that revision and publishes only if Check passes. A failed Check lists its issues and publishes nothing. Publishing a block that overruns a fixed start, with either Publish or Check & publish, first asks: the dialog names how much content is cut, and **Keep editing** publishes nothing.

The block selector and New block action sit above the builder and a compact event log. Start, type, event, length, and timing share aligned columns. Fixed starts have a clock marker; other starts are estimates calculated from catalog or declared clip duration, not promises that a track has aired. Unknown durations remain visible. Timing labels describe whether an event fits its boundary; **Check** and **Publish** independently validate audio availability.

Select an event to edit its source, fixed start, clip duration, or voice track in the Event inspector. On phones, selection scrolls to that inspector. The Fillers and Build block tabs keep generation controls available without repeating the sequence or putting a form in every row. Save, Discard, Check, and Publish stay above the log; it scrolls separately with its column headings visible. New block opens a creation dialog, and unsaved edits lock block selection. Events added at the end are inserted before an explicit terminal fixed Stop.

Leaving the Fillers or Build block tab while a preview is pending cancels applying its response. A late response cannot replace edits made in the Event inspector or after changing blocks.

`/console-fixture?state=rundown-desk` renders the same workspace with fictional timed news, music, filler cuts, and an unfilled gap. Persistence and publishing are disabled in that fixture. Browser acceptance covers the library, timeline, dense log and inspector at desktop and phone widths, plus source edits, filler preview, Save, and Publish through the normal authenticated local application.

### Continuous radio management

The Radio desk shows the saved continuous filler rotation whenever a timed block is not currently on air, including when future blocks are published. The ordinary transport controls remain connected to that rotation. The Rundown planner keeps a 24/7 continuous-fillers summary above optional timed blocks, with direct access to the live rotation. New blocks can start at any minute and are not forced to end after an hour; offsets, filler previews, duration estimates, and runtime timers follow explicit event boundaries. `/console-fixture?state=radio-continuous` covers a populated rotation with no scheduled blocks. `/console-fixture?state=radio-song-failed` shows the Radio desk alert for a song Palazzo could not load (#175). The existing rundown fixture retains its authored +3600 stop to demonstrate compatibility, rather than imposing that boundary on new blocks.
