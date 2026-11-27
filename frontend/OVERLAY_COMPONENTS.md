# Overlay Components

This document describes the Toni-style broadcast overlay components available in Alcantara.

These components use the visual language from **fifthbell/toni**: dark backgrounds, brand red accents, and a compact broadcast-style layout.

The Modo Italiano Giorgia variants follow Giorgia's broadcast language, taken from its artist bumper and the Giorgia templates in Broadway: square geometry with no rounded corners, navy (`#0a1234`), one signal magenta (`#ed0076`) used as a vertical rule and label colour, the white MI mark, condensed display type set directly on the picture over a navy grade, and hard cuts instead of fades.

All components are designed for a **1920 × 1080** broadcast canvas.

---

## Components

### `ToniChyron`

A lower-third overlay bar suitable for live broadcast. It renders a dark floating panel, animated red slug, gold divider, rotating social handles, and optional marquee scrolling when explicitly enabled.

```tsx
import { ToniChyron } from '~/components';

<ToniChyron
  text="Breaking news headline here"
  show={true}
  useMarquee={false}
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `text` | `string` | `''` | Chyron text to display |
| `show` | `boolean` | `false` | Controls visibility (slide-in/out animation) |
| `useMarquee` | `boolean` | `false` | Enables continuous marquee scrolling when `true` |

The marquee animation (`marqueeFlow`) scrolls text from right to left over 22 seconds. There is no automatic overflow detection in the current implementation.

---

### `ToniClock`

A rotating world-clock block. It cycles through a fixed city list and displays a 24-hour `HH:MM` time for the currently active city.

```tsx
import { ToniClock } from '~/components';

<ToniClock
  showSeconds={false}
  timeOverride={null}
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `showSeconds` | `boolean` | `false` | Accepted prop, but the current display still renders `HH:MM` only |
| `timeOverride` | `GlobalTimeOverride \| null` | `null` | Broadcast time override (see `broadcastTime.ts`) |

The city loop is fixed in code: Sanremo, New York, Madrid, Montevideo, and Santiago.

---

### `ToniLogo`

An image-based station identifier that crossfades through a fixed set of logo assets in the top-right corner.

```tsx
import { ToniLogo } from '~/components';

<ToniLogo
  callsign="MR"
  subtitle="MODORADIO"
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `callsign` | `string` | `'MR'` | Used for the generated image `alt` text |
| `subtitle` | `string` | — | Optional value appended to the generated image `alt` text |

No visible text is rendered by the current component. The visible output is the rotating image stack.

### `ModoItalianoGiorgiaClock`

The Giorgia clock is two pieces of type, not a card. Both follow the artist bumper in `@modoitaliano/giorgia`:

- **Header** (top-left, `left: 82px`, `top: 68px`): the white MI mark followed by the time and city as an uppercase label. The city changes with a hard cut.
- **On-air block** (bottom-left, `left: 82px`, `bottom: 70px`): shown only while a song is live. A square cover, the magenta rule, a magenta label ("Estás escuchando" / "In onda ora" / "On air now"), the artist as the hero line fitted to the width, and the song title beneath in wide-tracked Barlow. Both are fitted first and wrap when they cannot fit; neither is truncated. Playback progress is a hairline under the title. The block eases in and out over 450ms (fade and a short rise) so a song ending does not cut it off; while it leaves it keeps showing the song that just ended, and the headline beside it eases to its new size.

```tsx
import { ModoItalianoGiorgiaClock } from '~/components';

<ModoItalianoGiorgiaClock programId="modoitaliano" showWorldClocks showLogo showPlaybackProgress />
```

Use the component type `modoitaliano-giorgia-clock`. Its scene attributes are `showWorldClocks`, `showLogo`, `showPlaybackProgress` and `keySafe`. The `part` prop (`'all'`, `'header'`, `'onAir'`) lets the scene row place the two pieces separately. The on-air block reads the program audio bus and the song sequence, and honours the time override.

### `ModoItalianoGiorgiaChyron`

A Giorgia headline: uppercase Barlow Condensed 800 hanging from the magenta rule, set straight on a navy grade with no panel. The headline is fitted to the available width between 76px and 120px; when it cannot fit on one line at 76px it wraps onto as many balanced lines as it needs, growing upwards from the bottom edge. Nothing is clamped, clipped or cut with an ellipsis, including the call to action. The call to action is a magenta uppercase label above it. Showing, hiding and changing text are hard cuts. The explicit marquee option still scrolls a single 96px line.

```tsx
import { ModoItalianoGiorgiaChyron } from '~/components';

<ModoItalianoGiorgiaChyron show textSequence={textSequence} ctaSequence={ctaSequence} />
```

Use the component type `modoitaliano-giorgia-chyron`. Configure it with the program chyron editor. Standalone it spans `left`/`right: 82px`, `bottom: 70px`.

### `ModoItalianoGiorgiaArtistBumper`

Giorgia's own 12-second artist-and-song introduction, full screen. Alcantara does not define any of it: the composition (`ArtistBumper`), its timeline, layout and type come from the `@modoitaliano/giorgia` package (`@modoitaliano/giorgia/video`), played with Remotion's player the same way Giorgia's Storybook plays it. To change how the bumper looks, change it in Giorgia and bump the dependency.

It shows three image cuts, then the artist, song and credits over the fourth image, then the animated "In onda ora" card, which it holds. It plays once, silent, each time it is shown or its content changes.

```tsx
import { ModoItalianoGiorgiaArtistBumper } from '~/components';

<ModoItalianoGiorgiaArtistBumper artist="ROB" songTitle="Cento ragazze" labelId="artist:rob" />
```

Use the component type `modoitaliano-giorgia-artist-bumper`.

| Metadata key | Required | Meaning |
|--------------|----------|---------|
| `show` | no | Hides the bumper when `false` (default `true`) |
| `artist`, `songTitle` | yes | Text of the identity and on-air cards |
| `labelId` | one of the two | Media label to take the images from, as the slideshow does: the first four different images of the label, in its saved order. A label with one to three images still plays, repeating its images to fill the four cuts |
| `images` | one of the two | Exactly four different 16:9 image URLs, in playback order; used only when no label is set |
| `contentType`, `creditLines` | no | Left blank, Giorgia's default content type ("Singolo") applies and the credits stay empty |

The eyebrow ("ModoItaliano presenta") and the site address (`modoitaliano.fm`) are Giorgia's own defaults and cannot be changed here, and the bumper carries no audio.

Giorgia's composition throws unless it receives exactly four distinct images, so the component renders nothing until the artist, the song title and four images are available (from the label once it has loaded, or set by hand); the editor says which is missing. The Remotion player and Giorgia's video entry load only when a bumper is shown.

### Key-safe mode (chroma key scenes)

Set `keySafe: true` on `modoitaliano-giorgia-clock` or `modoitaliano-giorgia-chyron` (the editor has a checkbox on the clock) when the scene is shot over a chroma key. Set on either one, it applies to the whole pair.

Anything partly transparent over the key colour comes out of the keyer as a dirty fringe: the grade's gradient, text shadows, the rule's glow, and the edges of type that blend into the green. Magenta on green is the worst case. Key-safe mode removes all of it:

- The grade becomes an opaque navy band (`#070d2b`) across the full width with a hard top edge 44px above the tallest block. It appears and disappears with a cut, not a fade.
- The header (mark and time) sits on its own opaque navy plate that runs off the top-left corner.
- Type, the mark and the rule carry no shadow or glow.

The only edges left over the key colour are the straight sides of the navy shapes. Type positions and sizes are unchanged.

Shared tokens and helpers for both (`GIORGIA`, `GiorgiaMark`, `GiorgiaRule`, `GiorgiaGrade`, `fitGiorgiaText`) are exported by `@modoitaliano/giorgia/scenes`; the renderers themselves live in the package, loaded through `app/scenes/packagedScenes.tsx`.

---

## Overlay Route

A pre-built demo overlay page is available at `/overlay`. It renders all three Toni components on a transparent 1920 × 1080 canvas.

**OBS / vMix setup:**

1. Add a **Browser Source** with URL `http://localhost:<VITE_PORT>/overlay` (default 5173, or your deployed URL).
2. Set resolution to **1920 × 1080**.
3. Enable **Allow Transparency** / **Transparent Background** in the source settings.

---

## Using in `program/:id`

The components are available as named component types in the dynamic program renderer. Add any of the following to a layout's `componentType` (comma-separated) and configure via scene metadata:

| Component type | Metadata keys |
|----------------|---------------|
| `toni-chyron` | `text`, `useMarquee` |
| `toni-clock` | — |
| `toni-logo` | `callsign`, `subtitle` (used for image alt text only) |
| `modoitaliano-giorgia-clock` | `showWorldClocks`, `showLogo`, `showPlaybackProgress`, `keySafe` |
| `modoitaliano-giorgia-chyron` | `show`, `textSequence`, `ctaSequence`, `keySafe` |
| `modoitaliano-giorgia-artist-bumper` | `show`, `artist`, `songTitle`, `labelId`, `images`, `contentType`, `creditLines` |

Example scene metadata:

```json
{
  "toni-chyron": { "text": "Breaking news headline here", "useMarquee": true },
  "toni-logo": { "callsign": "MR", "subtitle": "MODORADIO" }
}
```

### Modo Italiano bottom row

The Giorgia family is the Modo Italiano look. The former chyron and clock (`modoitaliano-chyron`, `modoitaliano-clock`) are retired: the migration `20261127020000_giorgia_chyron_clock` moved every stored layout and its scene props to `modoitaliano-giorgia-chyron` and `modoitaliano-giorgia-clock` (the props contracts are the same), and the program renderer still draws an old id through its Giorgia replacement (`normalizeSceneComponentTypes` and `normalizeSceneMetadata` in `app/utils/programRow.ts`), so no scene goes blank. The bracket (`modoitaliano-bracket`) keeps its type and props and draws `ModoItalianoGiorgiaBracket` from `@modoitaliano/giorgia/scenes`, in the Giorgia look. `modoitaliano-podcast-player` is the last renderer from `@modoitaliano/giorgia/scenes/legacy`.

When a scene lists both `modoitaliano-giorgia-clock` and `modoitaliano-giorgia-chyron`, `resolveProgramRow` lays them out together along the bottom instead of rendering each standalone: `left`/`right: 82px`, `bottom: 70px`, the chyron in the left slot and the clock's on-air block in the right one, with the clock's header top-left. The headline keeps at least half the row, so a long now-playing title cannot squeeze it; while the chyron is hidden the on-air block takes the left edge. Any other component in the scene (for example `cronica-chyron` or `cronica-background`) renders standalone alongside the row.

The row is rendered by `ModoItalianoProgramRow` (`app/components/ModoItalianoProgramRow.tsx`). On its own, the Giorgia clock draws its header top-left and its on-air block bottom-left.

---

## Fonts

Shared Google Fonts are loaded globally in `app/root.tsx`, including `Barlow`, `Barlow Condensed`, `Encode Sans`, `EB Garamond`, `JetBrains Mono`, `Libre Franklin`, and `Plus Jakarta Sans`.

For the current Toni components:
- `ToniChyron` uses `Encode Sans`.
- `ToniClock` currently uses a system sans stack.
- `ToniLogo` is image-based.
- `ModoItalianoGiorgiaClock` and `ModoItalianoGiorgiaChyron` use `Barlow Condensed` (700 and 800) for display and labels and `Barlow` 700 for the song title.

---

## CSS Keyframes

`ToniChyron.css` defines the `marqueeFlow` keyframe used by the marquee animation:

```css
@keyframes marqueeFlow {
  from { transform: translateX(1920px); }
  to   { transform: translateX(-100%); }
}
```

The slide-in transition for the chyron uses a `cubic-bezier(0.16, 1, 0.3, 1)` easing over 550 ms.
