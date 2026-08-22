# Overlay Components

This document describes the Toni-style broadcast overlay components available in Alcantara.

These components use the visual language from **fifthbell/toni**: dark backgrounds, brand red accents, and a compact broadcast-style layout.

The Modo Italiano Giorgia variants use the Giorgia editorial language: deep navy surfaces, signal magenta (`#ed0076`), hard rectangular geometry, the white MI mark, and Barlow Condensed display typography.

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

A separate Giorgia-branded clock and now-playing overlay. It keeps the original Modo Italiano clock geometry, paired lower-third placement, cover treatment, world-clock rotation, program audio-bus integration, song-sequence support, and playback progress. The variant changes only the visual language: deep navy, signal magenta, and Giorgia typography.

```tsx
import { ModoItalianoGiorgiaClock } from '~/components';

<ModoItalianoGiorgiaClock
  programId="modoitaliano"
  showWorldClocks
  showLogo
  showPlaybackProgress
/>
```

Use the component type `modoitaliano-giorgia-clock`. Its configurable scene attributes match `modoitaliano-clock`: `showWorldClocks`, `showLogo`, and `showPlaybackProgress`.

### `ModoItalianoGiorgiaChyron`

A separate Giorgia-branded editorial lower third with a hard-edged navy panel, signal-magenta rule, and condensed editorial typography. It preserves the existing manual, autoplay, nested-sequence, CTA, and explicit-marquee behavior without adding a second logo. When paired with the Giorgia clock, the MI mark appears only in the clock.

```tsx
import { ModoItalianoGiorgiaChyron } from '~/components';

<ModoItalianoGiorgiaChyron
  show
  textSequence={textSequence}
  ctaSequence={ctaSequence}
/>
```

Use the component type `modoitaliano-giorgia-chyron`. Configure it with the same program chyron editor used by `modoitaliano-chyron`.

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

---

## Fonts

Shared Google Fonts are loaded globally in `app/root.tsx`, including `Encode Sans`, `EB Garamond`, `JetBrains Mono`, `Libre Franklin`, and `Plus Jakarta Sans`.

For the current Toni components:
- `ToniChyron` uses `Encode Sans`.
- `ToniClock` currently uses a system sans stack.
- `ToniLogo` is image-based.
- `ModoItalianoGiorgiaClock` and `ModoItalianoGiorgiaChyron` use `Barlow Condensed` with the shared global fallback stack.

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
