import React, { useState } from 'react';
import { BroadcastLayout, Ticker, ChyronHolder, ClockWidget, QRCodeWidget, LiveIndicator, LogoWidget, Header } from '../components';

export default function Preview() {
  const [activeDemo, setActiveDemo] = useState<string>('broadcast-layout');
  const [chyronText, setChyronText] = useState('LAS INTROS DEL FESTIVAL DE SANREMO');
  const [showChyron, setShowChyron] = useState(false);

  const demos = [
    { id: 'broadcast-layout', name: 'Broadcast Layout', description: 'Complete broadcast layout with all components' },
    { id: 'ticker', name: 'Ticker', description: 'Bottom ticker bar with hashtag and URL' },
    { id: 'chyron', name: 'Chyron', description: 'Animated message overlay' },
    { id: 'clock-widget', name: 'Clock Widget', description: 'Live updating clock display' },
    { id: 'qr-code', name: 'QR Code', description: 'QR code widget' },
    { id: 'live-indicator', name: 'Live Indicator', description: 'Animated LIVE badge' },
    { id: 'header', name: 'Header', description: 'Top header bar' }
  ];

  const renderDemo = () => {
    switch (activeDemo) {
      case 'broadcast-layout':
        return (
          <BroadcastLayout
            headerTitle='ModoSanremo | La evolución gráfica del Festival (1969-1989)'
            headerDate='23/01/2026'
            hashtag='#ModoSanremoMR'
            url='modoradio.cl'
            chyronText={chyronText}
            showChyron={showChyron}
            logoText='mr'
            showLiveIndicator={true}
            liveText='VIVO'
            qrCodeContent='https://modoradio.cl'
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#FFFFFF',
                fontSize: 'clamp(2rem, 4vw, 4rem)',
                textAlign: 'center',
                padding: '2rem'
              }}
            >
              Broadcast Layout Preview
            </div>
          </BroadcastLayout>
        );

      case 'ticker':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontSize: '2rem',
                textAlign: 'center'
              }}
            >
              Ticker Preview
            </div>
            <Ticker hashtag='#ModoSanremoMR' url='modoradio.cl' />
          </div>
        );

      case 'chyron':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: '30%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                textAlign: 'center',
                maxWidth: '600px',
                padding: '2rem'
              }}
            >
              <h2 style={{ marginBottom: '1rem' }}>Chyron Preview</h2>
              <input
                type='text'
                value={chyronText}
                onChange={(e) => setChyronText(e.target.value)}
                placeholder='Enter chyron text'
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  fontSize: '1rem',
                  marginBottom: '1rem',
                  borderRadius: '6px',
                  border: 'none'
                }}
              />
              <button
                onClick={() => setShowChyron(!showChyron)}
                style={{
                  padding: '0.75rem 1.5rem',
                  fontSize: '1rem',
                  background: '#5FB7E5',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                {showChyron ? 'Hide' : 'Show'} Chyron
              </button>
            </div>
            <Ticker hashtag='#ModoSanremoMR' url='modoradio.cl' />
            <ChyronHolder text={chyronText} show={showChyron} duration={10000} />
          </div>
        );

      case 'clock-widget':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', padding: '2rem' }}>
            <ClockWidget />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontSize: '2rem',
                textAlign: 'center'
              }}
            >
              Clock Widget Preview
            </div>
          </div>
        );

      case 'qr-code':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', padding: '2rem' }}>
            <QRCodeWidget content='https://modoradio.cl' />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontSize: '2rem',
                textAlign: 'center'
              }}
            >
              QR Code Widget Preview
            </div>
          </div>
        );

      case 'live-indicator':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', padding: '2rem' }}>
            <LiveIndicator text='VIVO' />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontSize: '2rem',
                textAlign: 'center'
              }}
            >
              Live Indicator Preview
            </div>
          </div>
        );

      case 'header':
        return (
          <div style={{ background: '#1a1a1a', minHeight: '100vh', padding: '2rem' }}>
            <Header title='ModoSanremo | La evolución gráfica del Festival' date='23/01/2026' />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontSize: '2rem',
                textAlign: 'center'
              }}
            >
              Header Component Preview
            </div>
          </div>
        );

      default:
        return <div>Select a component to preview</div>;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <div
        style={{
          width: '300px',
          background: '#f5f5f5',
          padding: '1.5rem',
          overflowY: 'auto',
          borderRight: '1px solid #ddd'
        }}
      >
        <h2 style={{ marginBottom: '1.5rem', fontSize: '1.5rem' }}>Component Preview</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {demos.map((demo) => (
            <button
              key={demo.id}
              onClick={() => {
                setActiveDemo(demo.id);
                setShowChyron(false);
              }}
              style={{
                padding: '1rem',
                textAlign: 'left',
                background: activeDemo === demo.id ? '#5FB7E5' : '#fff',
                color: activeDemo === demo.id ? '#fff' : '#000',
                border: activeDemo === demo.id ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontWeight: activeDemo === demo.id ? '600' : '400'
              }}
            >
              <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{demo.name}</div>
              <div
                style={{
                  fontSize: '0.875rem',
                  opacity: 0.8
                }}
              >
                {demo.description}
              </div>
            </button>
          ))}
        </div>
        <div style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid #ddd' }}>
          <a
            href='/control'
            style={{
              display: 'block',
              padding: '0.75rem',
              textAlign: 'center',
              background: '#6366f1',
              color: '#fff',
              textDecoration: 'none',
              borderRadius: '6px',
              fontWeight: '600'
            }}
          >
            ← Back to Control Panel
          </a>
        </div>
      </div>

      {/* Preview Area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>{renderDemo()}</div>
    </div>
  );
}
