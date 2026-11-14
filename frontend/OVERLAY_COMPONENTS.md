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
- **On-air block** (bottom-left, `left: 82px`, `bottom: 70px`): shown only while a song is live. A square cover, the magenta rule, a magenta label ("Estás escuchando" / "In onda ora" / "On air now"), the artist as the hero line fitted to the width, and the song title beneath in wide-tracked Barlow. Both are fitted first and wrap when they cannot fit; neither is truncated. Playback progress is a hairline under the title.

```tsx
import { ModoItalianoGiorgiaClock } from '~/components';

<ModoItalianoGiorgiaClock programId="modoitaliano" showWorldClocks showLogo showPlaybackProgress />
```

Use the component type `modoitaliano-giorgia-clock`. Its scene attributes match `modoitaliano-clock`: `showWorldClocks`, `showLogo`, and `showPlaybackProgress`. The `part` prop (`'all'`, `'header'`, `'onAir'`) lets the scene row place the two pieces separately. Song data, the program audio bus, song sequences and time overrides behave as in `modoitaliano-clock`.

### `ModoItalianoGiorgiaChyron`

A Giorgia headline: uppercase Barlow Condensed 800 hanging from the magenta rule, set straight on a navy grade with no panel. The headline is fitted to the available width between 76px and 120px; when it cannot fit on one line at 76px it wraps onto as many balanced lines as it needs, growing upwards from the bottom edge. Nothing is clamped, clipped or cut with an ellipsis, including the call to action. The call to action is a magenta uppercase label above it. Showing, hiding and changing text are hard cuts. The explicit marquee option still scrolls a single 96px line.

```tsx
import { ModoItalianoGiorgiaChyron } from '~/components';

<ModoItalianoGiorgiaChyron show textSequence={textSequence} ctaSequence={ctaSequence} />
```

Use the component type `modoitaliano-giorgia-chyron`. Configure it with the same program chyron editor used by `modoitaliano-chyron`. Standalone it spans `left`/`right: 82px`, `bottom: 70px`.

Shared tokens and helpers for both (`GIORGIA`, `GiorgiaMark`, `GiorgiaRule`, `GiorgiaGrade`, `fitGiorgiaText`) live in `app/components/giorgiaBroadcast.tsx`.

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
| `modoitaliano-giorgia-clock` | `showWorldClocks`, `showLogo`, `showPlaybackProgress` |
| `modoitaliano-giorgia-chyron` | `show`, `textSequence`, `ctaSequence` |

Example scene metadata:

```json
{
  "toni-chyron": { "text": "Breaking news headline here", "useMarquee": true },
  "toni-logo": { "callsign": "MR", "subtitle": "MODORADIO" }
}
```

### Modo Italiano bottom row

The Giorgia family is the current Modo Italiano look. The original family (`modoitaliano-clock`, `modoitaliano-chyron`, `modoitaliano-disclaimer`, `modoitaliano-bracket`, `modoitaliano-podcast-player`) is kept for legacy and historical scenes. Do not combine the two in one layout.

When a scene pairs a clock with its chyron, the renderer lays them out together along the bottom instead of rendering each standalone. `resolveProgramRow` in `app/utils/programRow.ts` makes that decision:

- `modoitaliano-giorgia-clock` rows only with `modoitaliano-giorgia-chyron`.
- `modoitaliano-clock` rows with `modoitaliano-chyron`, and without a chyron still moves into its row beside `modoitaliano-disclaimer`, `cronica-chyron`, `modoitaliano-bracket`, `modoitaliano-podcast-player`, or `modoitaliano-giorgia-podcast-player`.
- The families never pair with each other. A component of the other family in the same layout renders standalone, in its own position.
- A scene gets at most one row; the Giorgia pair takes it when both families are complete.
- The disclaimer takes the left slot of the legacy row only while no chyron is showing.

The anchoring clock decides the geometry:

| Anchor | Row position | Left slot | Right slot |
|--------|--------------|-----------|------------|
| `modoitaliano-clock` (legacy) | `left`/`right`/`bottom: 110px` | legacy chyron or disclaimer | the clock card, docked right |
| `modoitaliano-giorgia-clock` | `left`/`right: 82px`, `bottom: 70px` | the Giorgia chyron | the on-air block; the header stays top-left |

In the Giorgia row the headline keeps at least half the row, so a long now-playing title cannot squeeze it; while the chyron is hidden the on-air block takes the left edge. The legacy row is unchanged: the chyron slot shrinks freely and the clock card never does.

The row is rendered by `ModoItalianoProgramRow` (`app/components/ModoItalianoProgramRow.tsx`).

On their own, the legacy clock sits top-right (`top: 64px`, `right: 96px`) and the legacy chyron spans the bottom at `110px`.

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
