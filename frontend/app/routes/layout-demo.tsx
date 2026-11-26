import React, { useCallback, useRef, useState } from 'react';
import { Button, Card } from '@gaulatti/bleecker';
import { BroadcastLayout } from '../components';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

/**
 * Complete broadcast layout example matching the screenshot
 * Shows all components integrated together
 */
export default function BroadcastLayoutExample() {
  const [chyronText, setChyronText] = useState('');
  const [showChyron, setShowChyron] = useState(false);
  const [scale, setScale] = useState(1);
  const fitObserver = useRef<ResizeObserver | null>(null);

  // The stage is a fixed 1920x1080 canvas. It is scaled to the console's content column, and the
  // transform makes the frame the containing block of the stage's `position: fixed` widgets, so
  // the QR code stays inside the frame instead of covering the sidebar. React hands the frame over
  // when it mounts, and null when it unmounts.
  const frameRef = useCallback((frame: HTMLDivElement | null) => {
    fitObserver.current?.disconnect();
    fitObserver.current = null;
    if (!frame) return;
    const fit = () => setScale(Math.min(1, frame.clientWidth / STAGE_WIDTH));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    fitObserver.current = observer;
  }, []);

  const displayChyron = (text: string) => {
    setChyronText(text);
    setShowChyron(true);
  };

  return (
    <div ref={frameRef} data-testid='layout-demo-frame' className='w-full overflow-hidden' style={{ height: STAGE_HEIGHT * scale }}>
      <div data-testid='layout-demo-stage' style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
    <BroadcastLayout
      headerTitle='Program title'
      headerDate='23/01/2026'
      hashtag='#ProgramHashtag'
      url='example.com'
      chyronText={chyronText}
      showChyron={showChyron}
      chyronDuration={5000}
      showLiveIndicator={true}
      qrCodeContent='https://example.com'
    >
      <div className='flex h-full flex-col items-center justify-center px-6 py-10 text-white'>
        <h1 className='text-center text-4xl font-semibold'>Broadcast Layout Demo</h1>

        <Card className='mt-12 w-full max-w-2xl space-y-4 bg-white/10 p-8 text-white ring-white/20'>
          <h2 className='text-2xl font-semibold'>Test Chyron Messages</h2>
          <div className='flex flex-col gap-3'>
            <Button onClick={() => displayChyron('PROGRAM TITLE MESSAGE')} variant='primary' size='lg'>
              Show Title Message
            </Button>
            <Button onClick={() => displayChyron('Ahora suena: Beautiful Song - Amazing Artist')} variant='primary' size='lg'>
              Show Now Playing
            </Button>
            <Button onClick={() => displayChyron('ULTIMA HORA: Noticia importante en desarrollo')} variant='primary' size='lg'>
              Show Breaking News
            </Button>
            <Button onClick={() => setShowChyron(false)} variant='destructive' size='lg'>
              Hide Chyron
            </Button>
          </div>
        </Card>

        <Card className='mt-10 w-full max-w-4xl bg-white/5 p-8 text-white ring-white/15'>
          <h3 className='mb-4 text-xl font-semibold'>Layout Features</h3>
          <ul className='space-y-1 text-sm leading-7'>
            <li>Header: Black bar with program title and date</li>
            <li>Clock: Live time widget with icon (top-left)</li>
            <li>QR Code: Scannable code for viewers (left side)</li>
            <li>Live Indicator: Pulsing "VIVO" badge (top-right)</li>
            <li>Logo: Brand logo widget (bottom-right)</li>
            <li>Chyron: Animated message overlay (above ticker)</li>
            <li>Ticker: Bottom bar with hashtag and URL</li>
          </ul>
        </Card>
      </div>
    </BroadcastLayout>
      </div>
    </div>
  );
}
