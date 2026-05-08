export interface ComponentMetadata {
  id: string;
  name: string;
  description: string;
  hasConfigurableSceneAttributes: boolean;
  defaultProps: Record<string, any>;
}

export const OVERLAY_COMPONENTS: ComponentMetadata[] = [
  {
    id: 'ticker',
    name: 'Ticker',
    description: 'Bottom ticker bar with hashtag and URL',
    hasConfigurableSceneAttributes: true,
    defaultProps: { hashtag: '#ModoSanremoMR', url: 'modoradio.cl' }
  },
  {
    id: 'chyron',
    name: 'Chyron',
    description: 'Animated message overlay',
    hasConfigurableSceneAttributes: false,
    defaultProps: { text: '', duration: 5000 }
  },
  {
    id: 'header',
    name: 'Header',
    description: 'Top header bar with title and date',
    hasConfigurableSceneAttributes: true,
    defaultProps: { title: '', date: '' }
  },
  {
    id: 'clock-widget',
    name: 'Clock Widget',
    description: 'Live updating clock display',
    hasConfigurableSceneAttributes: true,
    defaultProps: { showIcon: true, iconUrl: '', timezone: 'America/Argentina/Buenos_Aires' }
  },
  {
    id: 'qr-code',
    name: 'QR Code',
    description: 'QR code widget',
    hasConfigurableSceneAttributes: true,
    defaultProps: { content: 'https://modoradio.cl' }
  },
  {
    id: 'live-indicator',
    name: 'Live Indicator',
    description: 'Animated LIVE badge',
    hasConfigurableSceneAttributes: false,
    defaultProps: { animate: true }
  },
  {
    id: 'logo-widget',
    name: 'Logo Widget',
    description: 'Program logo overlay',
    hasConfigurableSceneAttributes: false,
    defaultProps: { logoUrl: '', position: 'bottom-right' }
  },
  {
    id: 'slideshow',
    name: 'Slideshow',
    description: 'Image slideshow with transitions',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      mediaGroupId: null,
      images: [],
      intervalMs: 5000,
      transitionMs: 900,
      shuffle: false,
      fitMode: 'cover',
      kenBurns: true
    }
  },
  {
    id: 'video-stream',
    name: 'Video Stream',
    description: 'Live video stream input',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      sourceUrl: '',
      posterUrl: '',
      showControls: false,
      loop: false,
      autoPlay: true,
      objectFit: 'cover'
    }
  },
  {
    id: 'broadcast-layout',
    name: 'Broadcast Layout',
    description: 'Full broadcast layout with header, ticker, clock and QR',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      headerTitle: '',
      hashtag: '#ModoSanremoMR',
      url: 'modoradio.cl',
      qrCodeContent: 'https://modoradio.cl',
      clockTimezone: 'America/Argentina/Buenos_Aires',
      showChyron: false,
      chyronText: ''
    }
  },
  {
    id: 'reloj-clock',
    name: 'Reloj Clock',
    description: 'Analog clock with timezone support',
    hasConfigurableSceneAttributes: true,
    defaultProps: { timezone: 'America/Argentina/Buenos_Aires' }
  },
  {
    id: 'reloj-loop-clock',
    name: 'Reloj Loop (Analog)',
    description: 'Cycling analog clock with timezone rotation',
    hasConfigurableSceneAttributes: true,
    defaultProps: { timezone: 'Europe/Madrid' }
  },
  {
    id: 'reloj-digital-loop-clock',
    name: 'Reloj Digital',
    description: 'Broadcast-style digital clock with text/CTA sequences',
    hasConfigurableSceneAttributes: true,
    defaultProps: { timezone: 'America/New_York' }
  },
  {
    id: 'reloj-clone',
    name: 'Reloj Clone',
    description: 'Original clock clone',
    hasConfigurableSceneAttributes: false,
    defaultProps: {}
  },
  {
    id: 'toni-chyron',
    name: 'Toni Chyron',
    description: 'Chyron with social handles and presets',
    hasConfigurableSceneAttributes: true,
    defaultProps: { text: '', useMarquee: false, socialHandles: ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'] }
  },
  {
    id: 'fifthbell-chyron',
    name: 'Fifth Bell Chyron',
    description: 'Fifth Bell branded chyron',
    hasConfigurableSceneAttributes: true,
    defaultProps: { text: '', useMarquee: false, socialHandles: ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'] }
  },
  {
    id: 'toni-clock',
    name: 'Toni Clock',
    description: 'Clock with world city rotation',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      showWorldClocks: true,
      showBellIcon: false,
      worldClockRotateIntervalMs: 5000,
      worldClockTransitionMs: 300,
      worldClockShuffle: false,
      worldClockWidthPx: 200,
      worldClockCities: [
        { city: 'SANREMO', timezone: 'Europe/Rome' },
        { city: 'NEW YORK', timezone: 'America/New_York' },
        { city: 'MADRID', timezone: 'Europe/Madrid' },
        { city: 'MONTEVIDEO', timezone: 'America/Montevideo' },
        { city: 'SANTIAGO', timezone: 'America/Santiago' }
      ]
    }
  },
  {
    id: 'fifthbell-clock',
    name: 'Fifth Bell Clock',
    description: 'Fifth Bell branded world clock',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      showWorldClocks: true,
      showBellIcon: true,
      worldClockRotateIntervalMs: 5000,
      worldClockTransitionMs: 300,
      worldClockShuffle: false,
      worldClockWidthPx: 200,
      worldClockCities: [
        { city: 'SANREMO', timezone: 'Europe/Rome' },
        { city: 'NEW YORK', timezone: 'America/New_York' },
        { city: 'MADRID', timezone: 'Europe/Madrid' },
        { city: 'MONTEVIDEO', timezone: 'America/Montevideo' },
        { city: 'SANTIAGO', timezone: 'America/Santiago' }
      ]
    }
  },
  {
    id: 'fifthbell-corner',
    name: 'Fifth Bell Corner',
    description: 'Fifth Bell corner clock bug',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      showWorldClocks: true,
      showBellIcon: true,
      worldClockRotateIntervalMs: 7000,
      worldClockTransitionMs: 300,
      worldClockShuffle: true,
      worldClockWidthPx: 200
    }
  },
  {
    id: 'modoitaliano-clock',
    name: 'Modo Italiano Clock',
    description: 'Modo Italiano branded clock',
    hasConfigurableSceneAttributes: false,
    defaultProps: {}
  },
  {
    id: 'modoitaliano-chyron',
    name: 'Modo Italiano Chyron',
    description: 'Modo Italiano branded chyron with text sequences',
    hasConfigurableSceneAttributes: true,
    defaultProps: { show: true }
  },
  {
    id: 'modoitaliano-disclaimer',
    name: 'Modo Italiano Disclaimer',
    description: 'Disclaimer text overlay',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      text: 'Contenuti a scopo informativo.',
      show: true,
      align: 'right',
      bottomPx: 24,
      fontSizePx: 20,
      opacity: 0.82
    }
  },
  {
    id: 'toni-logo',
    name: 'Toni Logo',
    description: 'Station logo with callsign',
    hasConfigurableSceneAttributes: false,
    defaultProps: {}
  },
  {
    id: 'earone',
    name: 'Earone',
    description: 'Earone ranking display',
    hasConfigurableSceneAttributes: true,
    defaultProps: { label: 'EARONE', rank: '', spins: '' }
  },
  {
    id: 'cronica-background',
    name: 'Cronica Background',
    description: 'Cronica branded background',
    hasConfigurableSceneAttributes: true,
    defaultProps: {}
  },
  {
    id: 'cronica-chyron',
    name: 'Cronica Chyron',
    description: 'Cronica branded chyron',
    hasConfigurableSceneAttributes: true,
    defaultProps: { text: '' }
  },
  {
    id: 'cronica-reiteramos',
    name: 'Cronica Reiteramos',
    description: 'Cronica reiteramos overlay',
    hasConfigurableSceneAttributes: true,
    defaultProps: { text: 'REITERAMOS', show: true }
  },
  {
    id: 'fifthbell-content',
    name: 'Fifth Bell Content',
    description: 'Fifth Bell news/articles content panel',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      showArticles: true,
      showWeather: true,
      showEarthquakes: true,
      showMarkets: true,
      showCallsignTake: true,
      languageRotation: ['en', 'es', 'en', 'it'],
      dataLoadTimeoutMs: 15000,
      playlistDefaultDurationMs: 10000,
      playlistUpdateIntervalMs: 100,
      articlesDurationMs: 10000,
      weatherDurationMs: 5000,
      earthquakesDurationMs: 10000,
      marketsDurationMs: 10000,
      audioCueEnabled: true,
      audioCueMinute: 59,
      audioCueSecond: 55,
      callsignPrelaunchUntilNyc: '2026-01-02T21:30:00',
      callsignWindowStartSecond: 50,
      callsignWindowEndSecond: 3
    }
  },
  {
    id: 'fifthbell-marquee',
    name: 'Fifth Bell Marquee',
    description: 'Fifth Bell scrolling marquee',
    hasConfigurableSceneAttributes: true,
    defaultProps: {
      showMarquee: false,
      marqueeMinPostsCount: 4,
      marqueeMinAverageRelevance: 0,
      marqueeMinMedianRelevance: 0,
      marqueePixelsPerSecond: 150,
      marqueeMinDurationSeconds: 10,
      marqueeHeightPx: 72
    }
  },
  {
    id: 'fifthbell',
    name: 'Fifth Bell',
    description: 'Full Fifth Bell program display',
    hasConfigurableSceneAttributes: true,
    defaultProps: {}
  },
  {
    id: 'corner-bug',
    name: 'Corner Bug',
    description: 'Top-right corner bug overlay',
    hasConfigurableSceneAttributes: false,
    defaultProps: {}
  }
];

export function getComponentMetadata(id: string): ComponentMetadata | undefined {
  return OVERLAY_COMPONENTS.find((c) => c.id === id);
}

export function getDefaultPropsForComponent(id: string): Record<string, any> {
  const metadata = getComponentMetadata(id);
  return metadata?.defaultProps || {};
}

export const CONFIGURABLE_COMPONENT_IDS = new Set(
  OVERLAY_COMPONENTS.filter((c) => c.hasConfigurableSceneAttributes).map((c) => c.id)
);

export function hasConfigurableSceneAttributes(componentType: string): boolean {
  return CONFIGURABLE_COMPONENT_IDS.has(componentType);
}
