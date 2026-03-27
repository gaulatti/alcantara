import './SceneTransitionOverlay.css';
import type { SceneTransitionPreset } from '../utils/sceneTransitions';

interface SceneTransitionOverlayProps {
  transition: SceneTransitionPreset;
}

type TransitionFinishTone = 'warm' | 'cool' | 'alert' | 'neon';
type TransitionVectorVariant = 'election' | 'market' | 'world' | 'festival' | 'hit';
type TransitionSolidVariant = 'election' | 'market' | 'world' | 'festival' | 'hit';

function TransitionFinishLayer({ tone }: { tone: TransitionFinishTone }) {
  return (
    <>
      <div className={`scene-transition-overlay__sheen scene-transition-overlay__sheen--${tone}`} />
      <div className='scene-transition-overlay__grain' />
    </>
  );
}

function TransitionVectorLayer({ variant }: { variant: TransitionVectorVariant }) {
  if (variant === 'election') {
    return (
      <svg className='scene-transition-overlay__vector scene-transition-overlay__vector--election' viewBox='0 0 1920 1080' preserveAspectRatio='none' aria-hidden='true'>
        <defs>
          <linearGradient id='transitionElectionStroke' x1='0%' y1='0%' x2='100%' y2='0%'>
            <stop offset='0%' stopColor='rgba(255,255,255,0)' />
            <stop offset='50%' stopColor='rgba(224,244,255,0.9)' />
            <stop offset='100%' stopColor='rgba(255,255,255,0)' />
          </linearGradient>
          <linearGradient id='transitionElectionFill' x1='0%' y1='0%' x2='0%' y2='100%'>
            <stop offset='0%' stopColor='rgba(152,206,255,0.34)' />
            <stop offset='100%' stopColor='rgba(28,84,176,0.06)' />
          </linearGradient>
        </defs>
        <path d='M120 188 H1800' stroke='url(#transitionElectionStroke)' strokeWidth='3' />
        <path d='M120 892 H1800' stroke='url(#transitionElectionStroke)' strokeWidth='3' />
        <path d='M960 132 V948' stroke='rgba(224,244,255,0.28)' strokeWidth='2' strokeDasharray='10 12' />
        <path d='M260 860 V400 H500 V860 Z' fill='url(#transitionElectionFill)' stroke='rgba(224,244,255,0.22)' strokeWidth='2' />
        <path d='M780 860 V260 H1040 V860 Z' fill='url(#transitionElectionFill)' stroke='rgba(255,255,255,0.26)' strokeWidth='2' />
        <path d='M1320 860 V500 H1560 V860 Z' fill='url(#transitionElectionFill)' stroke='rgba(224,244,255,0.22)' strokeWidth='2' />
        <path d='M220 310 H1700' stroke='rgba(255,255,255,0.08)' strokeWidth='1' strokeDasharray='6 14' />
        <path d='M220 538 H1700' stroke='rgba(255,255,255,0.08)' strokeWidth='1' strokeDasharray='6 14' />
        <path d='M220 766 H1700' stroke='rgba(255,255,255,0.08)' strokeWidth='1' strokeDasharray='6 14' />
      </svg>
    );
  }

  if (variant === 'market') {
    return (
      <svg className='scene-transition-overlay__vector scene-transition-overlay__vector--market' viewBox='0 0 1920 1080' preserveAspectRatio='none' aria-hidden='true'>
        <defs>
          <linearGradient id='transitionMarketRise' x1='0%' y1='100%' x2='100%' y2='0%'>
            <stop offset='0%' stopColor='rgba(120,255,214,0.08)' />
            <stop offset='100%' stopColor='rgba(236,255,246,0.82)' />
          </linearGradient>
          <linearGradient id='transitionMarketCool' x1='0%' y1='0%' x2='100%' y2='100%'>
            <stop offset='0%' stopColor='rgba(200,255,232,0.08)' />
            <stop offset='100%' stopColor='rgba(120,255,214,0.62)' />
          </linearGradient>
        </defs>
        <path d='M150 250 H1770' stroke='rgba(255,255,255,0.06)' strokeWidth='1' strokeDasharray='6 10' />
        <path d='M150 540 H1770' stroke='rgba(255,255,255,0.06)' strokeWidth='1' strokeDasharray='6 10' />
        <path d='M150 830 H1770' stroke='rgba(255,255,255,0.06)' strokeWidth='1' strokeDasharray='6 10' />
        <path d='M180 760 L380 640 L520 690 L760 430 L920 500 L1120 320 L1360 440 L1600 250' fill='none' stroke='url(#transitionMarketRise)' strokeWidth='8' strokeLinecap='round' strokeLinejoin='round' />
        <path d='M240 820 L440 740 L650 610 L880 660 L1180 480 L1410 540 L1680 390' fill='none' stroke='url(#transitionMarketCool)' strokeWidth='5' strokeLinecap='round' strokeLinejoin='round' />
        <circle cx='1120' cy='320' r='12' fill='rgba(236,255,246,0.92)' />
        <circle cx='1600' cy='250' r='10' fill='rgba(236,255,246,0.9)' />
      </svg>
    );
  }

  if (variant === 'world') {
    return (
      <svg className='scene-transition-overlay__vector scene-transition-overlay__vector--world' viewBox='0 0 1920 1080' preserveAspectRatio='none' aria-hidden='true'>
        <defs>
          <linearGradient id='transitionWorldStroke' x1='0%' y1='0%' x2='100%' y2='0%'>
            <stop offset='0%' stopColor='rgba(255,255,255,0)' />
            <stop offset='50%' stopColor='rgba(224,244,255,0.86)' />
            <stop offset='100%' stopColor='rgba(255,255,255,0)' />
          </linearGradient>
        </defs>
        <ellipse cx='960' cy='540' rx='520' ry='230' fill='none' stroke='rgba(140,192,255,0.18)' strokeWidth='2' />
        <ellipse cx='960' cy='540' rx='380' ry='170' fill='none' stroke='rgba(224,244,255,0.22)' strokeWidth='2' />
        <path d='M440 540 H1480' stroke='url(#transitionWorldStroke)' strokeWidth='3' />
        <path d='M960 310 V770' stroke='rgba(224,244,255,0.24)' strokeWidth='2' />
        <path d='M560 370 C760 260 1160 260 1360 370' fill='none' stroke='rgba(224,244,255,0.18)' strokeWidth='2' />
        <path d='M560 710 C760 820 1160 820 1360 710' fill='none' stroke='rgba(224,244,255,0.18)' strokeWidth='2' />
        <path d='M630 260 C860 520 1060 520 1290 260' fill='none' stroke='rgba(160,214,255,0.16)' strokeWidth='2' />
        <path d='M630 820 C860 560 1060 560 1290 820' fill='none' stroke='rgba(160,214,255,0.16)' strokeWidth='2' />
      </svg>
    );
  }

  if (variant === 'festival') {
    return (
      <svg className='scene-transition-overlay__vector scene-transition-overlay__vector--festival' viewBox='0 0 1920 1080' preserveAspectRatio='none' aria-hidden='true'>
        <defs>
          <linearGradient id='transitionFestivalRunway' x1='0%' y1='100%' x2='100%' y2='0%'>
            <stop offset='0%' stopColor='rgba(255,120,214,0.12)' />
            <stop offset='50%' stopColor='rgba(255,228,168,0.42)' />
            <stop offset='100%' stopColor='rgba(255,255,255,0.1)' />
          </linearGradient>
        </defs>
        <path d='M560 940 L860 420 H1060 L1360 940 Z' fill='url(#transitionFestivalRunway)' stroke='rgba(255,244,214,0.18)' strokeWidth='2' />
        <path d='M700 940 L900 420' stroke='rgba(255,255,255,0.14)' strokeWidth='2' />
        <path d='M1220 940 L1020 420' stroke='rgba(255,255,255,0.14)' strokeWidth='2' />
        <path d='M240 240 L840 420' stroke='rgba(255,180,214,0.14)' strokeWidth='4' />
        <path d='M1680 220 L1080 420' stroke='rgba(255,208,108,0.16)' strokeWidth='4' />
        <circle cx='360' cy='210' r='14' fill='rgba(255,255,255,0.84)' />
        <circle cx='1560' cy='190' r='14' fill='rgba(255,255,255,0.84)' />
      </svg>
    );
  }

  return (
    <svg className='scene-transition-overlay__vector scene-transition-overlay__vector--hit' viewBox='0 0 1920 1080' preserveAspectRatio='none' aria-hidden='true'>
      <defs>
        <linearGradient id='transitionHitMarquee' x1='0%' y1='0%' x2='100%' y2='0%'>
          <stop offset='0%' stopColor='rgba(255,96,186,0.18)' />
          <stop offset='50%' stopColor='rgba(255,230,168,0.58)' />
          <stop offset='100%' stopColor='rgba(120,180,255,0.18)' />
        </linearGradient>
      </defs>
      <rect x='190' y='170' width='1540' height='740' rx='42' fill='none' stroke='url(#transitionHitMarquee)' strokeWidth='6' />
      <rect x='270' y='250' width='1380' height='580' rx='30' fill='rgba(255,255,255,0.02)' stroke='rgba(255,255,255,0.12)' strokeWidth='2' />
      <path d='M330 320 H1590' stroke='rgba(255,255,255,0.08)' strokeWidth='2' />
      <path d='M330 760 H1590' stroke='rgba(255,255,255,0.08)' strokeWidth='2' />
      <g fill='rgba(255,244,214,0.3)'>
        <circle cx='340' cy='200' r='6' /><circle cx='392' cy='200' r='6' /><circle cx='444' cy='200' r='6' />
        <circle cx='1476' cy='200' r='6' /><circle cx='1528' cy='200' r='6' /><circle cx='1580' cy='200' r='6' />
        <circle cx='340' cy='880' r='6' /><circle cx='392' cy='880' r='6' /><circle cx='444' cy='880' r='6' />
        <circle cx='1476' cy='880' r='6' /><circle cx='1528' cy='880' r='6' /><circle cx='1580' cy='880' r='6' />
      </g>
    </svg>
  );
}

function TransitionSolidLayer({ variant }: { variant: TransitionSolidVariant }) {
  if (variant === 'election') {
    return (
      <>
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--election-left' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--election-right' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--election-center' />
      </>
    );
  }

  if (variant === 'market') {
    return (
      <>
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--market-top' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--market-bottom' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--market-core' />
      </>
    );
  }

  if (variant === 'world') {
    return (
      <>
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--world-left' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--world-right' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--world-axis' />
      </>
    );
  }

  if (variant === 'festival') {
    return (
      <>
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--festival-runway' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--festival-left' />
        <div className='scene-transition-overlay__solid scene-transition-overlay__solid--festival-right' />
      </>
    );
  }

  return (
    <>
      <div className='scene-transition-overlay__solid scene-transition-overlay__solid--hit-frame' />
      <div className='scene-transition-overlay__solid scene-transition-overlay__solid--hit-band-left' />
      <div className='scene-transition-overlay__solid scene-transition-overlay__solid--hit-band-right' />
    </>
  );
}

export function SceneTransitionOverlay({ transition }: SceneTransitionOverlayProps) {
  if (transition.id === 'cut') {
    return null;
  }

  if (transition.id === 'velvet-eclipse') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--velvet-eclipse'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__veil' />
        <div className='scene-transition-overlay__halo scene-transition-overlay__halo--outer' />
        <div className='scene-transition-overlay__halo scene-transition-overlay__halo--inner' />
        <div className='scene-transition-overlay__iris scene-transition-overlay__iris--core' />
        <div className='scene-transition-overlay__iris scene-transition-overlay__iris--shadow' />
        <div className='scene-transition-overlay__sweep scene-transition-overlay__sweep--left' />
        <div className='scene-transition-overlay__sweep scene-transition-overlay__sweep--right' />
        <div className='scene-transition-overlay__crescent scene-transition-overlay__crescent--top' />
        <div className='scene-transition-overlay__crescent scene-transition-overlay__crescent--bottom' />
        <div className='scene-transition-overlay__curtain scene-transition-overlay__curtain--left' />
        <div className='scene-transition-overlay__curtain scene-transition-overlay__curtain--right' />
        <div className='scene-transition-overlay__strobe' />
        <div className='scene-transition-overlay__spark scene-transition-overlay__spark--one' />
        <div className='scene-transition-overlay__spark scene-transition-overlay__spark--two' />
      </div>
    );
  }

  if (transition.id === 'breaking-radar') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--breaking-radar'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__alarm-wash' />
        <div className='scene-transition-overlay__grid' />
        <div className='scene-transition-overlay__scanline scene-transition-overlay__scanline--one' />
        <div className='scene-transition-overlay__scanline scene-transition-overlay__scanline--two' />
        <div className='scene-transition-overlay__radar-ring scene-transition-overlay__radar-ring--outer' />
        <div className='scene-transition-overlay__radar-ring scene-transition-overlay__radar-ring--inner' />
        <div className='scene-transition-overlay__radar-sweep' />
        <div className='scene-transition-overlay__alert-panel scene-transition-overlay__alert-panel--left' />
        <div className='scene-transition-overlay__alert-panel scene-transition-overlay__alert-panel--center' />
        <div className='scene-transition-overlay__alert-panel scene-transition-overlay__alert-panel--right' />
        <div className='scene-transition-overlay__data-bar scene-transition-overlay__data-bar--top' />
        <div className='scene-transition-overlay__data-bar scene-transition-overlay__data-bar--bottom' />
        <div className='scene-transition-overlay__news-flash' />
      </div>
    );
  }

  if (transition.id === 'anchor-desk') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--anchor-desk'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__studio-wash' />
        <div className='scene-transition-overlay__horizon-line scene-transition-overlay__horizon-line--top' />
        <div className='scene-transition-overlay__horizon-line scene-transition-overlay__horizon-line--bottom' />
        <div className='scene-transition-overlay__glass-band scene-transition-overlay__glass-band--left' />
        <div className='scene-transition-overlay__glass-band scene-transition-overlay__glass-band--center' />
        <div className='scene-transition-overlay__glass-band scene-transition-overlay__glass-band--right' />
        <div className='scene-transition-overlay__studio-core' />
        <div className='scene-transition-overlay__studio-shutter scene-transition-overlay__studio-shutter--left' />
        <div className='scene-transition-overlay__studio-shutter scene-transition-overlay__studio-shutter--right' />
        <div className='scene-transition-overlay__studio-glint scene-transition-overlay__studio-glint--top' />
        <div className='scene-transition-overlay__studio-glint scene-transition-overlay__studio-glint--bottom' />
        <div className='scene-transition-overlay__studio-flare' />
      </div>
    );
  }

  if (transition.id === 'election-wall') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--election-wall'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__election-wash' />
        <div className='scene-transition-overlay__election-grid' />
        <TransitionSolidLayer variant='election' />
        <div className='scene-transition-overlay__election-column scene-transition-overlay__election-column--one' />
        <div className='scene-transition-overlay__election-column scene-transition-overlay__election-column--two' />
        <div className='scene-transition-overlay__election-column scene-transition-overlay__election-column--three' />
        <TransitionVectorLayer variant='election' />
        <div className='scene-transition-overlay__election-beam' />
        <div className='scene-transition-overlay__election-slate scene-transition-overlay__election-slate--left' />
        <div className='scene-transition-overlay__election-slate scene-transition-overlay__election-slate--right' />
        <div className='scene-transition-overlay__election-flash' />
        <TransitionFinishLayer tone='cool' />
      </div>
    );
  }

  if (transition.id === 'market-pulse') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--market-pulse'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__market-wash' />
        <div className='scene-transition-overlay__market-ticker scene-transition-overlay__market-ticker--top' />
        <div className='scene-transition-overlay__market-ticker scene-transition-overlay__market-ticker--bottom' />
        <TransitionSolidLayer variant='market' />
        <div className='scene-transition-overlay__market-chart scene-transition-overlay__market-chart--left' />
        <div className='scene-transition-overlay__market-chart scene-transition-overlay__market-chart--right' />
        <TransitionVectorLayer variant='market' />
        <div className='scene-transition-overlay__market-pulse-line' />
        <div className='scene-transition-overlay__market-spike scene-transition-overlay__market-spike--one' />
        <div className='scene-transition-overlay__market-spike scene-transition-overlay__market-spike--two' />
        <div className='scene-transition-overlay__market-core' />
        <TransitionFinishLayer tone='cool' />
      </div>
    );
  }

  if (transition.id === 'world-desk') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--world-desk'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__world-wash' />
        <TransitionSolidLayer variant='world' />
        <div className='scene-transition-overlay__world-orbit scene-transition-overlay__world-orbit--outer' />
        <div className='scene-transition-overlay__world-orbit scene-transition-overlay__world-orbit--inner' />
        <div className='scene-transition-overlay__world-latitude' />
        <div className='scene-transition-overlay__world-meridian' />
        <TransitionVectorLayer variant='world' />
        <div className='scene-transition-overlay__world-scan' />
        <div className='scene-transition-overlay__world-panel scene-transition-overlay__world-panel--left' />
        <div className='scene-transition-overlay__world-panel scene-transition-overlay__world-panel--right' />
        <div className='scene-transition-overlay__world-flare' />
        <TransitionFinishLayer tone='cool' />
      </div>
    );
  }

  if (transition.id === 'festival-runway') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--festival-runway'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__festival-wash' />
        <TransitionSolidLayer variant='festival' />
        <div className='scene-transition-overlay__festival-strip scene-transition-overlay__festival-strip--left' />
        <div className='scene-transition-overlay__festival-strip scene-transition-overlay__festival-strip--center' />
        <div className='scene-transition-overlay__festival-strip scene-transition-overlay__festival-strip--right' />
        <TransitionVectorLayer variant='festival' />
        <div className='scene-transition-overlay__festival-lamp scene-transition-overlay__festival-lamp--one' />
        <div className='scene-transition-overlay__festival-lamp scene-transition-overlay__festival-lamp--two' />
        <div className='scene-transition-overlay__festival-lamp scene-transition-overlay__festival-lamp--three' />
        <div className='scene-transition-overlay__festival-lamp scene-transition-overlay__festival-lamp--four' />
        <div className='scene-transition-overlay__festival-curtain scene-transition-overlay__festival-curtain--left' />
        <div className='scene-transition-overlay__festival-curtain scene-transition-overlay__festival-curtain--right' />
        <div className='scene-transition-overlay__festival-flash' />
        <div className='scene-transition-overlay__festival-sparkle' />
        <TransitionFinishLayer tone='warm' />
      </div>
    );
  }

  if (transition.id === 'hit-parade') {
    return (
      <div
        className='scene-transition-overlay scene-transition-overlay--hit-parade'
        style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
        aria-hidden='true'
      >
        <div className='scene-transition-overlay__hit-wash' />
        <div className='scene-transition-overlay__hit-marquee scene-transition-overlay__hit-marquee--top' />
        <div className='scene-transition-overlay__hit-marquee scene-transition-overlay__hit-marquee--bottom' />
        <TransitionSolidLayer variant='hit' />
        <div className='scene-transition-overlay__hit-bar scene-transition-overlay__hit-bar--one' />
        <div className='scene-transition-overlay__hit-bar scene-transition-overlay__hit-bar--two' />
        <div className='scene-transition-overlay__hit-bar scene-transition-overlay__hit-bar--three' />
        <div className='scene-transition-overlay__hit-bar scene-transition-overlay__hit-bar--four' />
        <TransitionVectorLayer variant='hit' />
        <div className='scene-transition-overlay__hit-pop scene-transition-overlay__hit-pop--left' />
        <div className='scene-transition-overlay__hit-pop scene-transition-overlay__hit-pop--center' />
        <div className='scene-transition-overlay__hit-pop scene-transition-overlay__hit-pop--right' />
        <div className='scene-transition-overlay__hit-logo-shell'>
          <img className='scene-transition-overlay__hit-logo' src='/mi.svg' alt='' />
        </div>
        <div className='scene-transition-overlay__hit-shine' />
        <div className='scene-transition-overlay__hit-flash' />
        <TransitionFinishLayer tone='neon' />
      </div>
    );
  }

  return (
    <div
      className='scene-transition-overlay scene-transition-overlay--crescendo-prism'
      style={{ ['--scene-transition-duration' as string]: `${transition.durationMs}ms` }}
      aria-hidden='true'
    >
      <div className='scene-transition-overlay__vignette' />
      <div className='scene-transition-overlay__aurora' />
      <div className='scene-transition-overlay__equalizer' />
      <div className='scene-transition-overlay__beam scene-transition-overlay__beam--far-left' />
      <div className='scene-transition-overlay__beam scene-transition-overlay__beam--left' />
      <div className='scene-transition-overlay__beam scene-transition-overlay__beam--right' />
      <div className='scene-transition-overlay__beam scene-transition-overlay__beam--far-right' />
      <div className='scene-transition-overlay__spine' />
      <div className='scene-transition-overlay__flash' />
      <div className='scene-transition-overlay__reveal scene-transition-overlay__reveal--left' />
      <div className='scene-transition-overlay__reveal scene-transition-overlay__reveal--center' />
      <div className='scene-transition-overlay__reveal scene-transition-overlay__reveal--right' />
      <div className='scene-transition-overlay__glint scene-transition-overlay__glint--top' />
      <div className='scene-transition-overlay__glint scene-transition-overlay__glint--bottom' />
    </div>
  );
}
