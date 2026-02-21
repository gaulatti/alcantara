import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useSSE } from '../hooks/useSSE';
import { BroadcastLayout, Ticker, ChyronHolder, Header, ClockWidget, QRCodeWidget, LiveIndicator, LogoWidget } from '../components';
import RelojClone from '../components/RelojClone';
import type { GlobalTimeOverride } from '../utils/broadcastTime';

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

export default function Program() {
  const { id } = useParams();
  const programId = id ?? 'main';
  const [state, setState] = useState<ProgramState | null>(null);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);

  useEffect(() => {
    fetch(`http://localhost:3000/program/${encodeURIComponent(programId)}/state`)
      .then((res) => res.json())
      .then((data) => setState(data))
      .catch((err) => console.error('Failed to fetch initial state:', err));
  }, [programId]);

  useEffect(() => {
    fetch('http://localhost:3000/program/broadcast-settings')
      .then((res) => res.json())
      .then((data) => setBroadcastSettings(data))
      .catch((err) => console.error('Failed to fetch broadcast settings:', err));
  }, []);

  useSSE({
    url: `http://localhost:3000/program/${encodeURIComponent(programId)}/events`,
    onMessage: (data) => {
      if (data.type === 'scene_change') {
        setState(data.state);
      } else if (data.type === 'scene_update') {
        setState((prev) => {
          if (!prev || !prev.activeScene) return prev;
          return {
            ...prev,
            activeScene: data.scene
          };
        });
      } else if (data.type === 'chyron_update') {
        setState((prev) => {
          if (!prev || !prev.activeScene) return prev;
          return {
            ...prev,
            activeScene: {
              ...prev.activeScene,
              chyronText: data.scene.chyronText
            }
          };
        });
      } else if (data.type === 'scene_cleared') {
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
    broadcastSettings?.timeOverrideEnabled &&
    !!broadcastSettings.timeOverrideStartTime &&
    !!broadcastSettings.timeOverrideStartedAt
      ? {
          startTime: broadcastSettings.timeOverrideStartTime,
          startedAt: broadcastSettings.timeOverrideStartedAt
        }
      : null;

  const renderScene = () => {
    if (!state?.activeScene) {
      return <div className='w-full h-full flex items-center justify-center text-white text-4xl'>No Active Scene</div>;
    }

    const scene = state.activeScene;
    const components = scene.layout.componentType.split(',').filter(Boolean);

    // Parse metadata
    let metadata: any = {};
    try {
      metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
    }

    console.log('=== RENDERING SCENE ===');
    console.log('Scene:', scene.name);
    console.log('Layout:', scene.layout.name);
    console.log('Component types (raw):', scene.layout.componentType);
    console.log('Components array:', components);
    console.log('Metadata (raw):', scene.metadata);
    console.log('Metadata (parsed):', metadata);
    console.log('Metadata type:', typeof metadata);
    console.log('Is array?:', Array.isArray(metadata));
    console.log('Metadata keys:', Object.keys(metadata));

    // Handle legacy single-component layouts
    if (components.length === 1) {
      const componentType = components[0];
      console.log('Single component mode:', componentType);

      if (componentType === 'lower-third') {
        return <LowerThird chyronText={scene.chyronText} />;
      }
      if (componentType === 'full-screen') {
        return <FullScreen chyronText={scene.chyronText} />;
      }
      if (componentType === 'corner-bug') {
        return <CornerBug chyronText={scene.chyronText} />;
      }
    }

    // Handle broadcast-layout component
    if (components.includes('broadcast-layout')) {
      console.log('Using broadcast-layout component');
      const props = metadata['broadcast-layout'] || {};
      console.log('Broadcast layout props:', props);
      return (
        <BroadcastLayout
          headerTitle={props.headerTitle || ''}
          hashtag={props.hashtag || '#ModoSanremoMR'}
          url={props.url || 'modoradio.cl'}
          chyronText={scene.chyronText || ''}
          showChyron={!!scene.chyronText}
          qrCodeContent={props.qrCodeContent || 'https://modoradio.cl'}
          clockTimezone={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
          showLiveIndicator={true}
          timeOverride={globalTimeOverride}
        />
      );
    }

    // Handle multi-component custom layouts
    console.log('Rendering multi-component layout...');
    return (
      <div className='w-full h-full relative bg-transparent'>
        {components.map((componentType) => {
          const props = metadata[componentType] || {};
          console.log(`Rendering component: ${componentType}`, 'Props:', props);

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
                  <ChyronHolder text={scene.chyronText || props.text || 'Chyron'} show={true} />
                </div>
              );
            case 'header':
              return <Header key={componentType} title={props.title || 'Header'} date={props.date || new Date().toLocaleDateString()} />;
            case 'clock-widget':
              return (
                <ClockWidget
                  key={componentType}
                  iconUrl={props.iconUrl}
                  timezone={props.timezone}
                  timeOverride={globalTimeOverride}
                />
              );
            case 'qr-code':
              return <QRCodeWidget key={componentType} content={props.content || 'https://example.com'} />;
            case 'live-indicator':
              return <LiveIndicator key={componentType} animate={props.animate ?? true} />;
            case 'logo-widget':
              return <LogoWidget key={componentType} logoUrl={props.logoUrl} position={props.position} />;
            case 'reloj-clock':
              return (
                <RelojClone
                  key={componentType}
                  timezone={props.timezone || 'America/Argentina/Buenos_Aires'}
                  timeOverride={globalTimeOverride}
                />
              );
            case 'corner-bug':
              return (
                <div key={componentType} style={{ position: 'absolute', top: '32px', right: '32px' }}>
                  <CornerBug chyronText={scene.chyronText} />
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
      </div>
    );
  };

  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {renderScene()}
    </div>
  );
}

function LowerThird({ chyronText }: { chyronText: string | null }) {
  return (
    <div className='absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-r from-blue-600 to-blue-800 flex items-center px-16'>
      <div className='text-white'>
        <div className='text-5xl font-bold'>{chyronText || 'Lower Third'}</div>
      </div>
    </div>
  );
}

function FullScreen({ chyronText }: { chyronText: string | null }) {
  return (
    <div className='w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900 to-blue-900'>
      <div className='text-white text-8xl font-bold text-center px-16'>{chyronText || 'Full Screen'}</div>
    </div>
  );
}

function CornerBug({ chyronText }: { chyronText: string | null }) {
  return (
    <div className='absolute top-8 right-8 bg-red-600 text-white px-8 py-4 rounded-lg shadow-2xl'>
      <div className='text-3xl font-bold'>{chyronText || 'LIVE'}</div>
    </div>
  );
}
