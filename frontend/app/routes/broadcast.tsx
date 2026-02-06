import React, { useState } from 'react';
import { Ticker, ChyronHolder } from '../components';

/**
 * Example usage of Ticker and ChyronHolder components
 *
 * The Ticker component displays a fixed bottom bar with hashtag and URL
 * The ChyronHolder sits above it and can display timed messages
 */
export default function BroadcastExample() {
  const [chyronText, setChyronText] = useState('');
  const [showChyron, setShowChyron] = useState(false);

  const displayChyron = (text: string) => {
    setChyronText(text);
    setShowChyron(true);
  };

  return (
    <div style={{ padding: '2rem', paddingBottom: '12vh' }}>
      <h1>Broadcast Ticker Demo</h1>

      <div style={{ marginTop: '2rem' }}>
        <h2>Test Chyron Messages</h2>
        <button onClick={() => displayChyron('Breaking News: This is a test message')} style={{ margin: '0.5rem', padding: '0.75rem 1.5rem' }}>
          Show Breaking News
        </button>
        <button onClick={() => displayChyron('Now Playing: Amazing Song Title - Artist Name')} style={{ margin: '0.5rem', padding: '0.75rem 1.5rem' }}>
          Show Now Playing
        </button>
        <button onClick={() => setShowChyron(false)} style={{ margin: '0.5rem', padding: '0.75rem 1.5rem' }}>
          Hide Chyron
        </button>
      </div>

      <div style={{ marginTop: '2rem' }}>
        <h3>Component Features:</h3>
        <ul>
          <li>
            <strong>Ticker:</strong> Fixed bottom bar, responsive, customizable hashtag and URL
          </li>
          <li>
            <strong>ChyronHolder:</strong> Animated overlay above ticker, auto-hide after duration
          </li>
          <li>
            <strong>Scaling:</strong> Optimized for Full HD (1920x1080) with responsive breakpoints
          </li>
        </ul>
      </div>

      {/* The ticker and chyron components */}
      <Ticker hashtag='#ModoitalianoMR' url='modoradio.cl' />
      <ChyronHolder text={chyronText} show={showChyron} duration={5000} />
    </div>
  );
}
