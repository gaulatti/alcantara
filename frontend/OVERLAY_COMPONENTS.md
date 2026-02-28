# Overlay Components

This document describes the Toni-style broadcast overlay components available in Alcantara.

These components use the visual language from **fifthbell/toni**: dark backgrounds, brand red accents, and a compact broadcast-style layout.

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

---

## Overlay Route

A pre-built demo overlay page is available at `/overlay`. It renders all three Toni components on a transparent 1920 × 1080 canvas.

**OBS / vMix setup:**

1. Add a **Browser Source** with URL `http://localhost:5173/overlay` (or your deployed URL).
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
