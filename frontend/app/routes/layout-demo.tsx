import React, { useState } from 'react';
import { BroadcastLayout } from '../components';

/**
 * Complete broadcast layout example matching the screenshot
 * Shows all components integrated together
 */
export default function BroadcastLayoutExample() {
  const [chyronText, setChyronText] = useState('');
  const [showChyron, setShowChyron] = useState(false);

  const displayChyron = (text: string) => {
    setChyronText(text);
    setShowChyron(true);
  };

  return (
    <BroadcastLayout
      headerTitle='ModoSanremo | La evolución gráfica del Festival (1969-1989)'
      headerDate='23/01/2026'
      hashtag='#ModoSanremoMR'
      url='modoradio.cl'
      chyronText={chyronText}
      showChyron={showChyron}
      chyronDuration={5000}
      showLiveIndicator={true}
      qrCodeContent='https://modoradio.cl'
    >
      {/* Main Content Area */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#FFFFFF'
        }}
      >
        <h1
          style={{
            fontSize: 'clamp(2rem, 4vw, 4rem)',
            marginBottom: '3rem',
            textAlign: 'center'
          }}
        >
          Broadcast Layout Demo
        </h1>

        <div
          style={{
            background: 'rgba(255, 255, 255, 0.1)',
            padding: '2rem',
            borderRadius: '12px',
            maxWidth: '600px',
            width: '100%'
          }}
        >
          <h2 style={{ marginBottom: '1.5rem' }}>Test Chyron Messages</h2>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem'
            }}
          >
            <button
              onClick={() => displayChyron('LAS INTROS DEL FESTIVAL DE SANREMO')}
              style={{
                padding: '1rem 1.5rem',
                fontSize: '1rem',
                background: '#5FB7E5',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Show Title Message
            </button>

            <button
              onClick={() => displayChyron('Ahora suena: Beautiful Song - Amazing Artist')}
              style={{
                padding: '1rem 1.5rem',
                fontSize: '1rem',
                background: '#5FB7E5',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Show Now Playing
            </button>

            <button
              onClick={() => displayChyron('ÚLTIMA HORA: Noticia importante en desarrollo')}
              style={{
                padding: '1rem 1.5rem',
                fontSize: '1rem',
                background: '#5FB7E5',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Show Breaking News
            </button>

            <button
              onClick={() => setShowChyron(false)}
              style={{
                padding: '1rem 1.5rem',
                fontSize: '1rem',
                background: '#FF4444',
                color: '#FFF',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Hide Chyron
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: '3rem',
            padding: '2rem',
            background: 'rgba(255, 255, 255, 0.05)',
            borderRadius: '12px',
            maxWidth: '800px'
          }}
        >
          <h3 style={{ marginBottom: '1rem' }}>Layout Features:</h3>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              lineHeight: '1.8'
            }}
          >
            <li>
              ✓ <strong>Header:</strong> Black bar with program title and date
            </li>
            <li>
              ✓ <strong>Clock:</strong> Live time widget with icon (top-left)
            </li>
            <li>
              ✓ <strong>QR Code:</strong> Scannable code for viewers (left side)
            </li>
            <li>
              ✓ <strong>Live Indicator:</strong> Pulsing "VIVO" badge (top-right)
            </li>
            <li>
              ✓ <strong>Logo:</strong> Brand logo widget (bottom-right)
            </li>
            <li>
              ✓ <strong>Chyron:</strong> Animated message overlay (above ticker)
            </li>
            <li>
              ✓ <strong>Ticker:</strong> Bottom bar with hashtag and URL
            </li>
          </ul>
        </div>
      </div>
    </BroadcastLayout>
  );
}
