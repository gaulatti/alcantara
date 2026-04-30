export interface ComponentMetadata {
  id: string;
  name: string;
  description: string;
  defaultProps: Record<string, any>;
}

export const OVERLAY_COMPONENTS: ComponentMetadata[] = [
  {
    id: 'ticker',
    name: 'Ticker',
    description: 'Bottom ticker bar with hashtag and URL',
    defaultProps: { hashtag: '#ModoSanremoMR', url: 'modoradio.cl' }
  },
  {
    id: 'chyron',
    name: 'Chyron',
    description: 'Animated message overlay',
    defaultProps: { text: '', duration: 5000 }
  },
  {
    id: 'header',
    name: 'Header',
    description: 'Top header bar',
    defaultProps: { title: '', date: new Date().toLocaleDateString() }
  },
  {
    id: 'clock-widget',
    name: 'Clock Widget',
    description: 'Live updating clock display',
    defaultProps: { showIcon: true, iconUrl: '', timezone: 'America/Argentina/Buenos_Aires' }
  },
  {
    id: 'qr-code',
    name: 'QR Code',
    description: 'QR code widget',
    defaultProps: { content: 'https://modoradio.cl' }
  },
  {
    id: 'live-indicator',
    name: 'Live Indicator',
    description: 'Animated LIVE badge',
    defaultProps: { animate: true }
  },
  {
    id: 'reloj-loop-clock',
    name: 'Reloj Loop (Analog)',
    description: 'Cycling analog clock',
    defaultProps: { timezone: 'Europe/Madrid' }
  },
  {
    id: 'reloj-digital-loop-clock',
    name: 'Reloj Digital',
    description: 'Broadcast-style digital clock',
    defaultProps: { timezone: 'America/New_York' }
  },
  {
    id: 'reloj-clone',
    name: 'Reloj Clone',
    description: 'Original clock clone',
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
