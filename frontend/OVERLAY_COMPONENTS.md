# Overlay Components

This document describes the Toni-style broadcast overlay components available in Alcantara.

These components use the visual language from **fifthbell/toni**: dark backgrounds, brand red (`#b21100`) accents, and typographic conventions (Libre Franklin, EB Garamond, JetBrains Mono).

All components are designed for a **1920 × 1080** broadcast canvas.

---

## Components

### `ToniChyron`

A lower-third overlay bar suitable for live broadcast. Features a dark semi-transparent background, a red left accent stripe, and optional marquee scrolling for long text.

```tsx
import { ToniChyron } from '~/components';

<ToniChyron
  text="Breaking news headline here"
  show={true}
  useMarquee={false}   // auto-detected when omitted
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `text` | `string` | `''` | Chyron text to display |
| `show` | `boolean` | `false` | Controls visibility (slide-in/out animation) |
| `useMarquee` | `boolean` | auto | Force marquee on/off; auto-detects overflow when omitted |

The marquee animation (`toniMarqueeScroll`) scrolls text from right to left over 18 seconds. When `useMarquee` is not provided, the component measures the text and only enables marquee when the text overflows the container.

---

### `ToniClock`

A digital clock display using **JetBrains Mono** for that broadcast-ready monospace look. Supports timezone overrides and a seconds display.

```tsx
import { ToniClock } from '~/components';

<ToniClock
  timezone="America/Argentina/Buenos_Aires"
  showSeconds={true}
  label="Buenos Aires"
  timeOverride={null}
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `timezone` | `string` | `'America/Argentina/Buenos_Aires'` | IANA timezone string |
| `showSeconds` | `boolean` | `true` | Show `HH:MM:SS` (true) or `HH:MM` (false) |
| `label` | `string` | — | Optional city/station label below the time |
| `timeOverride` | `GlobalTimeOverride \| null` | `null` | Broadcast time override (see `broadcastTime.ts`) |

Time format matches Toni's `CallsignSlide` behavior: zero-padded 24-hour `HH:MM:SS`.

---

### `ToniLogo`

A callsign / station-identifier badge using **EB Garamond** for the large callsign text and Libre Franklin for the subtitle.

```tsx
import { ToniLogo } from '~/components';

<ToniLogo
  callsign="MR"
  subtitle="MODORADIO"
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `callsign` | `string` | `'MR'` | Large callsign text (EB Garamond) |
| `subtitle` | `string` | — | Optional subtitle in brand red (Libre Franklin) |

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
| `toni-clock` | `timezone`, `showSeconds`, `label` |
| `toni-logo` | `callsign`, `subtitle` |

Example scene metadata:

```json
{
  "toni-clock": { "timezone": "America/New_York", "label": "New York" },
  "toni-logo": { "callsign": "MR", "subtitle": "MODORADIO" },
  "toni-chyron": { "useMarquee": true }
}
```

---

## Fonts

The following Google Fonts are loaded globally:

| Font | Usage |
|------|-------|
| Libre Franklin | Chyron text, clock label, logo subtitle |
| EB Garamond | Logo callsign text |
| JetBrains Mono | Clock digits |

They are declared in `app/root.tsx` and require an internet connection at runtime (or can be self-hosted).

---

## CSS Keyframes

`ToniChyron.css` defines the `toniMarqueeScroll` keyframe used by the marquee animation:

```css
@keyframes toniMarqueeScroll {
  0%   { transform: translateX(100%); }
  100% { transform: translateX(-100%); }
}
```

The slide-in transition for the chyron uses a `cubic-bezier(0.4, 0, 0.2, 1)` easing over 400 ms.
