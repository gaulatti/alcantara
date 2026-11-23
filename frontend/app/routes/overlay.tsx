import { FifthBellChyron, ToniClock, ToniLogo } from '../components';

/** The overlay's marks, from the page's URL: `callsign`, `subtitle`, `chyron`, and one or more `logo`. */
export function overlayMarks(search: string) {
  const params = new URLSearchParams(search);
  const text = (name: string) => params.get(name)?.trim() ?? '';
  return {
    callsign: text('callsign'),
    subtitle: text('subtitle'),
    chyron: text('chyron'),
    logos: params.getAll('logo').map((logo) => logo.trim()).filter(Boolean),
  };
}

/**
 * Overlay page — renders the Toni-style broadcast overlay components
 * (clock, logo, chyron) on a transparent 1920×1080 canvas.
 *
 * Capture this page in OBS/vMix as a browser source at 1920×1080 with
 * "Allow transparency" enabled. The station's marks come from the source's
 * URL, for example `/overlay?callsign=XY&subtitle=STATION&logo=/x.png&chyron=Welcome`.
 * A mark that is not given is not drawn: the page never shows a default
 * station name (gaulatti/alcantara#333).
 */
export default function Overlay() {
  const marks = overlayMarks(typeof window === 'undefined' ? '' : window.location.search);
  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {/* Top-right header block (clock + logo), matching Toni positions */}
      <ToniClock />
      {marks.logos.length > 0 ? <ToniLogo callsign={marks.callsign} subtitle={marks.subtitle || undefined} logos={marks.logos} /> : null}

      {/* Bottom: lower-third chyron */}
      {marks.chyron ? <FifthBellChyron text={marks.chyron} show={true} /> : null}
    </div>
  );
}
