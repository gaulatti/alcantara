import { useEffect, useState } from 'react';
import { FifthBellChyron, ToniClock, ToniLogo } from '../components';
import { apiUrl } from '../utils/apiBaseUrl';

export interface OverlayMarks {
  callsign: string;
  subtitle: string;
  chyron: string;
  logos: string[];
}

const NO_MARKS: OverlayMarks = { callsign: '', subtitle: '', chyron: '', logos: [] };
/** How often the overlay re-reads its program's active scene. */
const PROGRAM_REFRESH_MS = 15_000;

/** The marks the overlay's URL gives explicitly: `callsign`, `subtitle`, `chyron`, and one or more `logo`. */
export function overlayMarks(search: string): OverlayMarks & { program: string } {
  const params = new URLSearchParams(search);
  const text = (name: string) => params.get(name)?.trim() ?? '';
  return {
    program: text('program'),
    callsign: text('callsign'),
    subtitle: text('subtitle'),
    chyron: text('chyron'),
    logos: params.getAll('logo').map((logo) => logo.trim()).filter(Boolean),
  };
}

/**
 * A program's own marks, from its active scene as the program page reads it: the
 * toni-logo component's callsign and subtitle, and the scene's chyron text.
 */
export function programMarks(activeScene: unknown): OverlayMarks {
  if (!activeScene || typeof activeScene !== 'object') return NO_MARKS;
  const scene = activeScene as { chyronText?: unknown; metadata?: unknown };
  let metadata: Record<string, unknown> = {};
  if (typeof scene.metadata === 'string' && scene.metadata.trim()) {
    try {
      const parsed = JSON.parse(scene.metadata);
      if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  } else if (scene.metadata && typeof scene.metadata === 'object') {
    metadata = scene.metadata as Record<string, unknown>;
  }
  const logo = (metadata['toni-logo'] ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return { callsign: text(logo.callsign), subtitle: text(logo.subtitle), chyron: text(scene.chyronText), logos: [] };
}

/** Explicit URL marks win over the program's own, one by one. */
export function mergeMarks(explicit: OverlayMarks, program: OverlayMarks): OverlayMarks {
  return {
    callsign: explicit.callsign || program.callsign,
    subtitle: explicit.subtitle || program.subtitle,
    chyron: explicit.chyron || program.chyron,
    logos: explicit.logos.length ? explicit.logos : program.logos,
  };
}

/**
 * Overlay page — renders the Toni-style broadcast overlay components
 * (clock, logo, chyron) on a transparent 1920×1080 canvas.
 *
 * Capture this page in OBS/vMix as a browser source at 1920×1080 with
 * "Allow transparency" enabled, as `/overlay?program=<id>`: the station's marks
 * come from that program's active scene (its toni-logo callsign and subtitle, and
 * its chyron), refreshed every 15 seconds. `callsign`, `subtitle`, `chyron` and
 * `logo` in the URL override them. Without a program or explicit marks, nothing
 * branded is drawn: the page never shows a default station (gaulatti/alcantara#333).
 */
export default function Overlay() {
  /* v8 ignore next -- the page reads its URL during render, and this route only renders in the browser, where a window always exists */
  const explicit = overlayMarks(typeof window === 'undefined' ? '' : window.location.search);
  const [fromProgram, setFromProgram] = useState<OverlayMarks>(NO_MARKS);

  useEffect(() => {
    if (!explicit.program) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(apiUrl(`/program/${encodeURIComponent(explicit.program)}/state`));
        if (!response.ok) throw new Error(`program state ${response.status}`);
        const state = (await response.json()) as { activeScene?: unknown };
        if (!cancelled) setFromProgram(programMarks(state.activeScene));
      } catch {
        // An unreadable program draws no marks rather than stale or default ones.
        if (!cancelled) setFromProgram(NO_MARKS);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), PROGRAM_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [explicit.program]);

  const marks = mergeMarks(explicit, fromProgram);
  const hasLogo = marks.logos.length > 0 || Boolean(marks.callsign);
  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {/* Top-right header block (clock + logo), matching Toni positions */}
      <ToniClock />
      {hasLogo ? (
        <ToniLogo
          callsign={marks.callsign}
          subtitle={marks.subtitle || undefined}
          {...(marks.logos.length ? { logos: marks.logos } : {})}
        />
      ) : null}

      {/* Bottom: lower-third chyron */}
      {marks.chyron ? <FifthBellChyron text={marks.chyron} show={true} /> : null}
    </div>
  );
}
