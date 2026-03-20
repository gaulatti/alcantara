import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useSSE } from '../hooks/useSSE';
import { apiUrl } from '../utils/apiBaseUrl';
import {
  BroadcastLayout,
  Ticker,
  ChyronHolder,
  Header,
  ClockWidget,
  QRCodeWidget,
  LiveIndicator,
  LogoWidget,
  ToniChyron,
  ToniClock,
  ToniLogo,
  Earone,
  ModoItalianoClock,
  ModoItalianoChyron,
  ModoItalianoDisclaimer
} from '../components';
import RelojClone from '../components/RelojClone';
import RelojLoopClock from '../components/RelojLoopClock';
import FifthBellProgram from '../programs/fifthbell/FifthBellProgram.tsx';
import { SceneTransitionOverlay } from '../components/SceneTransitionOverlay';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { resolveToniChyronLeaf } from '../utils/toniChyronSequence';
import { getSceneTransitionPreset, type SceneTransitionPreset } from '../utils/sceneTransitions';
import { BACKEND_SANREMO_REALTIME_URL, buildEaroneRealtimeLookup, matchEaroneRealtimeEntry, type EaroneRealtimeLookup } from '../utils/earoneRealtime';

interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

interface ProgramState {
  id: number;
  activeSceneId: number | null;
  activeScene: Scene | null;
  updatedAt: string;
}

interface BroadcastSettings {
  id: number;
  timeOverrideEnabled: boolean;
  timeOverrideStartTime: string | null;
  timeOverrideStartedAt: string | null;
  updatedAt: string;
}

interface SceneChangeEvent {
  type: 'scene_change';
  transitionId?: string | null;
  state: ProgramState;
}

interface ActiveTransition {
  sequence: number;
  preset: SceneTransitionPreset;
}

const FIFTHBELL_DRIVER_COMPONENT_TYPES = new Set([
  'fifthbell',
  'fifthbell-content',
  'fifthbell-marquee',
  'fifthbell-corner'
]);
const FIFTHBELL_LAYOUT_COMPONENT_TYPES = new Set([
  ...FIFTHBELL_DRIVER_COMPONENT_TYPES,
  'toni-clock'
]);

export default function Program() {
  const { id } = useParams();
  const programId = id ?? 'main';

  return <SceneProgram programId={programId} />;
}

function SceneProgram({ programId }: { programId: string }) {
  const [state, setState] = useState<ProgramState | null>(null);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [earoneLookup, setEaroneLookup] = useState<EaroneRealtimeLookup | null>(null);
  const [activeTransition, setActiveTransition] = useState<ActiveTransition | null>(null);
  const transitionTimersRef = useRef<number[]>([]);
  const transitionSequenceRef = useRef(0);

  const clearTransitionTimers = () => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transitionTimersRef.current = [];
  };

  useEffect(() => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transitionTimersRef.current = [];
    setActiveTransition(null);
    setState(null);

    fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`))
      .then((res) => res.json())
      .then((data) => setState(data))
      .catch((err) => console.error('Failed to fetch initial state:', err));
  }, [programId]);

  useEffect(() => {
    return () => {
      transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      transitionTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    fetch(apiUrl('/program/broadcast-settings'))
      .then((res) => res.json())
      .then((data) => setBroadcastSettings(data))
      .catch((err) => console.error('Failed to fetch broadcast settings:', err));
  }, []);

  useEffect(() => {
    const componentTypes = state?.activeScene?.layout.componentType.split(',').filter(Boolean) || [];
    const needsEaroneRealtime = componentTypes.includes('earone');

    if (!needsEaroneRealtime) {
      return;
    }

    let cancelled = false;

    const loadEarone = async () => {
      try {
        const res = await fetch(BACKEND_SANREMO_REALTIME_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        if (!cancelled) {
          setEaroneLookup(buildEaroneRealtimeLookup(payload));
        }
      } catch (err) {
        console.error('Failed to fetch EarOne realtime data:', err);
      }
    };

    void loadEarone();
    const timer = window.setInterval(() => {
      void loadEarone();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state?.activeScene?.id, state?.activeScene?.layout.componentType]);

  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(programId)}/events`),
    onMessage: (data) => {
      if (data.type === 'scene_change') {
        const event = data as SceneChangeEvent;
        const preset = getSceneTransitionPreset(event.transitionId);
        const canAnimate = preset.id !== 'cut' && !!state?.activeScene && !!event.state.activeScene && state.activeSceneId !== event.state.activeSceneId;

        clearTransitionTimers();

        if (!canAnimate) {
          setActiveTransition(null);
          setState(event.state);
          return;
        }

        transitionSequenceRef.current += 1;
        setActiveTransition({
          sequence: transitionSequenceRef.current,
          preset
        });

        const cutTimer = window.setTimeout(() => {
          setState(event.state);
        }, preset.cutPointMs);

        const cleanupTimer = window.setTimeout(() => {
          setActiveTransition(null);
          transitionTimersRef.current = [];
        }, preset.durationMs);

        transitionTimersRef.current = [cutTimer, cleanupTimer];
      } else if (data.type === 'scene_update') {
        setState((prev) => {
          if (!prev || !prev.activeScene || prev.activeScene.id !== data.scene.id) return prev;
          return {
            ...prev,
            activeScene: data.scene
          };
        });
      } else if (data.type === 'scene_cleared') {
        clearTransitionTimers();
        setActiveTransition(null);
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeSceneId: null,
            activeScene: null
          };
        });
      } else if (data.type === 'broadcast_settings_update') {
        setBroadcastSettings(data.settings);
      }
    }
  });

  const globalTimeOverride: GlobalTimeOverride | null =
    broadcastSettings?.timeOverrideEnabled && !!broadcastSettings.timeOverrideStartTime && !!broadcastSettings.timeOverrideStartedAt
      ? {
          startTime: broadcastSettings.timeOverrideStartTime,
          startedAt: broadcastSettings.timeOverrideStartedAt
        }
      : null;

  const renderScene = (scene: Scene | null) => {
    if (!scene) {
      return <div className='w-full h-full flex items-center justify-center text-white text-4xl'>No Active Scene</div>;
    }

    const components = scene.layout.componentType.split(',').filter(Boolean);

    // Parse metadata
    let metadata: any = {};
    try {
      metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
    }

    const activeToniLeaf = resolveToniChyronLeaf(metadata['toni-chyron'] || {});
    const matchedEaroneEntry = matchEaroneRealtimeEntry(earoneLookup, {
      earoneSongId: activeToniLeaf?.earoneSongId || null,
      text: activeToniLeaf?.text || null
    });
    const hasOnlyFifthBellComponents =
      components.length > 0 &&
      components.every((componentType) => FIFTHBELL_LAYOUT_COMPONENT_TYPES.has(componentType)) &&
      components.some((componentType) => FIFTHBELL_DRIVER_COMPONENT_TYPES.has(componentType));
    const hasModoItalianoClock = components.includes('modoitaliano-clock');
    const hasModoItalianoChyron = components.includes('modoitaliano-chyron');
    const hasModoItalianoDisclaimer = components.includes('modoitaliano-disclaimer');
    const shouldRenderModoItalianoRow = hasModoItalianoClock && (hasModoItalianoChyron || hasModoItalianoDisclaimer);
    const modoItalianoClockProps = metadata['modoitaliano-clock'] || {};
    const modoItalianoChyronProps = metadata['modoitaliano-chyron'] || {};
    const modoItalianoDisclaimerProps = metadata['modoitaliano-disclaimer'] || {};
    const toBoolean = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
      }
      return fallback;
    };
    const modoItalianoDisclaimerText = typeof modoItalianoDisclaimerProps.text === 'string' ? modoItalianoDisclaimerProps.text.trim() : '';
    const shouldShowModoItalianoChyronComponent =
      shouldRenderModoItalianoRow && hasModoItalianoChyron && toBoolean(modoItalianoChyronProps.show, true);
    const showModoItalianoDisclaimer =
      shouldRenderModoItalianoRow &&
      hasModoItalianoDisclaimer &&
      !shouldShowModoItalianoChyronComponent &&
      toBoolean(modoItalianoDisclaimerProps.show, true) &&
      !!modoItalianoDisclaimerText;

    if (hasOnlyFifthBellComponents) {
      return (
        <div className='absolute inset-0'>
          <FifthBellProgram programId={programId} embedded sceneMetadata={metadata} activeComponents={components} />
        </div>
      );
    }

    // Handle legacy single-component layouts
    if (components.length === 1) {
      const componentType = components[0];
      const legacyProps = metadata[componentType] || {};

      if (componentType === 'lower-third') {
        return <LowerThird text={legacyProps.text} />;
      }
      if (componentType === 'full-screen') {
        return <FullScreen text={legacyProps.text} />;
      }
      if (componentType === 'corner-bug') {
        return <CornerBug text={legacyProps.text} />;
      }
    }

    // Handle broadcast-layout component
    if (components.includes('broadcast-layout')) {
      const props = metadata['broadcast-layout'] || {};
      return (
        <BroadcastLayout
          headerTitle={props.headerTitle || ''}
          hashtag={props.hashtag || '#ModoSanremoMR'}
          url={props.url || 'modoradio.cl'}
          chyronText={props.chyronText || ''}
          showChyron={Boolean(props.showChyron ?? !!props.chyronText)}
          qrCodeContent={props.qrCodeContent || 'https://modoradio.cl'}
          clockTimezone={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
          showLiveIndicator={true}
          timeOverride={globalTimeOverride}
        />
      );
    }

    const firstFifthBellComponentType = components.find((componentType) => FIFTHBELL_DRIVER_COMPONENT_TYPES.has(componentType));

    // Handle multi-component custom layouts
    return (
      <div className='w-full h-full relative bg-transparent'>
        {components.map((componentType) => {
          const props = metadata[componentType] || {};

          switch (componentType) {
            case 'ticker':
              return (
                <div key={componentType} style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
                  <Ticker hashtag={props.hashtag || '#Default'} url={props.url || 'website.com'} />
                </div>
              );
            case 'chyron':
              return (
                <div key={componentType} style={{ position: 'absolute', bottom: '120px', left: 0, right: 0 }}>
                  <ChyronHolder text={props.text || 'Chyron'} show={true} />
                </div>
              );
            case 'header':
              return <Header key={componentType} title={props.title || 'Header'} date={props.date || new Date().toLocaleDateString()} />;
            case 'clock-widget':
              return <ClockWidget key={componentType} iconUrl={props.iconUrl} timezone={props.timezone} timeOverride={globalTimeOverride} />;
            case 'qr-code':
              return <QRCodeWidget key={componentType} content={props.content || 'https://example.com'} />;
            case 'live-indicator':
              return <LiveIndicator key={componentType} animate={props.animate ?? true} />;
            case 'logo-widget':
              return <LogoWidget key={componentType} logoUrl={props.logoUrl} position={props.position} />;
            case 'reloj-clock':
              return <RelojClone key={componentType} timezone={props.timezone || 'America/Argentina/Buenos_Aires'} timeOverride={globalTimeOverride} />;
            case 'reloj-loop-clock':
              return <RelojLoopClock key={componentType} timezone={props.timezone || 'Europe/Madrid'} />;
            case 'toni-chyron':
              return (
                <ToniChyron
                  key={componentType}
                  text={props.text || ''}
                  show={true}
                  useMarquee={props.useMarquee}
                  contentMode={props.contentMode}
                  sequence={props.sequence}
                />
              );
            case 'toni-clock':
              return (
                <ToniClock
                  key={componentType}
                  timeOverride={globalTimeOverride}
                  cities={Array.isArray(props.worldClockCities) ? props.worldClockCities : undefined}
                  rotationIntervalMs={typeof props.worldClockRotateIntervalMs === 'number' ? props.worldClockRotateIntervalMs : undefined}
                  transitionDurationMs={typeof props.worldClockTransitionMs === 'number' ? props.worldClockTransitionMs : undefined}
                  shuffleCities={typeof props.worldClockShuffle === 'boolean' ? props.worldClockShuffle : undefined}
                  widthPx={typeof props.worldClockWidthPx === 'number' ? props.worldClockWidthPx : undefined}
                  showWorldClocks={typeof props.showWorldClocks === 'boolean' ? props.showWorldClocks : undefined}
                  showBellIcon={typeof props.showBellIcon === 'boolean' ? props.showBellIcon : undefined}
                />
              );
            case 'modoitaliano-clock': {
              if (shouldRenderModoItalianoRow) {
                return null;
              }
              return (
                <ModoItalianoClock
                  key={componentType}
                  timeOverride={globalTimeOverride}
                  transitionDurationMs={300}
                  shuffleCities={false}
                  widthPx={220}
                  showWorldClocks={true}
                  showBellIcon={false}
                  songs={Array.isArray(props.songs) ? props.songs : undefined}
                  songContentMode={typeof props.songContentMode === 'string' ? props.songContentMode : undefined}
                  songSequence={props.songSequence}
                  songArtist={typeof props.songArtist === 'string' ? props.songArtist : ''}
                  songTitle={typeof props.songTitle === 'string' ? props.songTitle : ''}
                  songCoverUrl={typeof props.songCoverUrl === 'string' ? props.songCoverUrl : ''}
                  songEaroneSongId={typeof props.songEaroneSongId === 'string' ? props.songEaroneSongId : ''}
                  songEaroneRank={typeof props.songEaroneRank === 'string' ? props.songEaroneRank : ''}
                  songEaroneSpins={typeof props.songEaroneSpins === 'string' ? props.songEaroneSpins : ''}
                  language='es'
                />
              );
            }
            case 'modoitaliano-chyron':
              if (shouldRenderModoItalianoRow) {
                return null;
              }
              return (
                <ModoItalianoChyron
                  key={componentType}
                  cta={typeof props.cta === 'string' ? props.cta : ''}
                  text={typeof props.text === 'string' ? props.text : ''}
                  show={typeof props.show === 'boolean' ? props.show : true}
                  useMarquee={typeof props.useMarquee === 'boolean' ? props.useMarquee : false}
                  textContentMode={typeof props.textContentMode === 'string' ? props.textContentMode : undefined}
                  textSequence={props.textSequence}
                  ctaContentMode={typeof props.ctaContentMode === 'string' ? props.ctaContentMode : undefined}
                  ctaSequence={props.ctaSequence}
                />
              );
            case 'modoitaliano-disclaimer':
              if (shouldRenderModoItalianoRow) {
                return null;
              }
              return (
                <ModoItalianoDisclaimer
                  key={componentType}
                  text={props.text || ''}
                  show={typeof props.show === 'boolean' ? props.show : true}
                  align={props.align === 'left' || props.align === 'center' || props.align === 'right' ? props.align : undefined}
                  bottomPx={typeof props.bottomPx === 'number' ? props.bottomPx : undefined}
                  fontSizePx={typeof props.fontSizePx === 'number' ? props.fontSizePx : undefined}
                  opacity={typeof props.opacity === 'number' ? props.opacity : undefined}
                />
              );
            case 'toni-logo':
              return <ToniLogo key={componentType} callsign={props.callsign || 'MR'} subtitle={props.subtitle} />;
            case 'earone':
              return (
                <Earone
                  key={componentType}
                  label={props.label || 'EARONE'}
                  rank={props.rank || matchedEaroneEntry?.ranking || activeToniLeaf?.earoneRank}
                  spins={props.spins || matchedEaroneEntry?.radioSpinsToday || activeToniLeaf?.earoneSpins}
                />
              );
            case 'fifthbell':
            case 'fifthbell-content':
            case 'fifthbell-marquee':
            case 'fifthbell-corner':
              if (firstFifthBellComponentType !== componentType) {
                return null;
              }
              return (
                <div key={componentType} className='absolute inset-0'>
                  <FifthBellProgram programId={programId} embedded sceneMetadata={metadata} activeComponents={components} />
                </div>
              );
            case 'corner-bug':
              return (
                <div key={componentType} style={{ position: 'absolute', top: '32px', right: '32px' }}>
                  <CornerBug text={props.text} />
                </div>
              );
            default:
              console.warn('Unknown component type:', componentType);
              return (
                <div key={componentType} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white' }}>
                  Unknown component: {componentType}
                </div>
              );
          }
        })}
        {shouldRenderModoItalianoRow && (
          <div className='absolute z-[950] flex items-end gap-6' style={{ left: '110px', right: '110px', bottom: '110px' }}>
            <div className='flex-1 min-w-0'>
              {shouldShowModoItalianoChyronComponent ? (
                <ModoItalianoChyron
                  cta={typeof modoItalianoChyronProps.cta === 'string' ? modoItalianoChyronProps.cta : ''}
                  text={typeof modoItalianoChyronProps.text === 'string' ? modoItalianoChyronProps.text : ''}
                  show
                  useMarquee={typeof modoItalianoChyronProps.useMarquee === 'boolean' ? modoItalianoChyronProps.useMarquee : false}
                  textContentMode={typeof modoItalianoChyronProps.textContentMode === 'string' ? modoItalianoChyronProps.textContentMode : undefined}
                  textSequence={modoItalianoChyronProps.textSequence}
                  ctaContentMode={typeof modoItalianoChyronProps.ctaContentMode === 'string' ? modoItalianoChyronProps.ctaContentMode : undefined}
                  ctaSequence={modoItalianoChyronProps.ctaSequence}
                  inline
                />
              ) : showModoItalianoDisclaimer ? (
                <ModoItalianoDisclaimer
                  text={modoItalianoDisclaimerProps.text || ''}
                  show
                  align={
                    modoItalianoDisclaimerProps.align === 'left' ||
                    modoItalianoDisclaimerProps.align === 'center' ||
                    modoItalianoDisclaimerProps.align === 'right'
                      ? modoItalianoDisclaimerProps.align
                      : 'right'
                  }
                  fontSizePx={typeof modoItalianoDisclaimerProps.fontSizePx === 'number' ? modoItalianoDisclaimerProps.fontSizePx : 20}
                  opacity={typeof modoItalianoDisclaimerProps.opacity === 'number' ? modoItalianoDisclaimerProps.opacity : 0.82}
                  inline
                />
              ) : null}
            </div>
            <div className='shrink-0'>
              <ModoItalianoClock
                timeOverride={globalTimeOverride}
                transitionDurationMs={300}
                shuffleCities={false}
                widthPx={220}
                showWorldClocks={true}
                showBellIcon={false}
                songs={Array.isArray(modoItalianoClockProps.songs) ? modoItalianoClockProps.songs : undefined}
                songContentMode={typeof modoItalianoClockProps.songContentMode === 'string' ? modoItalianoClockProps.songContentMode : undefined}
                songSequence={modoItalianoClockProps.songSequence}
                songArtist={typeof modoItalianoClockProps.songArtist === 'string' ? modoItalianoClockProps.songArtist : ''}
                songTitle={typeof modoItalianoClockProps.songTitle === 'string' ? modoItalianoClockProps.songTitle : ''}
                songCoverUrl={typeof modoItalianoClockProps.songCoverUrl === 'string' ? modoItalianoClockProps.songCoverUrl : ''}
                songEaroneSongId={typeof modoItalianoClockProps.songEaroneSongId === 'string' ? modoItalianoClockProps.songEaroneSongId : ''}
                songEaroneRank={typeof modoItalianoClockProps.songEaroneRank === 'string' ? modoItalianoClockProps.songEaroneRank : ''}
                songEaroneSpins={typeof modoItalianoClockProps.songEaroneSpins === 'string' ? modoItalianoClockProps.songEaroneSpins : ''}
                language='es'
                inline
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {renderScene(state?.activeScene ?? null)}
      {activeTransition && <SceneTransitionOverlay key={activeTransition.sequence} transition={activeTransition.preset} />}
    </div>
  );
}

function LowerThird({ text }: { text?: string }) {
  return (
    <div className='absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-r from-blue-600 to-blue-800 flex items-center px-16'>
      <div className='text-white'>
        <div className='text-5xl font-bold'>{text || 'Lower Third'}</div>
      </div>
    </div>
  );
}

function FullScreen({ text }: { text?: string }) {
  return (
    <div className='w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900 to-blue-900'>
      <div className='text-white text-8xl font-bold text-center px-16'>{text || 'Full Screen'}</div>
    </div>
  );
}

function CornerBug({ text }: { text?: string }) {
  return (
    <div className='absolute top-8 right-8 bg-red-600 text-white px-8 py-4 rounded-lg shadow-2xl'>
      <div className='text-3xl font-bold'>{text || 'LIVE'}</div>
    </div>
  );
}
