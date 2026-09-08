import { ToniChyron, ToniClock, ToniLogo } from '../components';

/**
 * Overlay page — renders the Toni-style broadcast overlay components
 * (clock, logo, chyron) on a transparent 1920×1080 canvas.
 *
 * Capture this page in OBS/vMix as a browser source at 1920×1080 with
 * "Allow transparency" enabled.
 */
export default function Overlay() {
  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {/* Top-right header block (clock + logo), matching Toni positions */}
      <ToniClock />
      <ToniLogo callsign='MR' subtitle='MODORADIO' />

      {/* Bottom: lower-third chyron */}
      <ToniChyron text='Bienvenidos a Modoradio' show={true} />
    </div>
  );
}
