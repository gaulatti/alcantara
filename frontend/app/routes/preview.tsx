import React, { useState } from 'react';
import { Button, Card, Input, SectionHeader } from '@gaulatti/bleecker';
import {
  BroadcastLayout,
  ChyronHolder,
  ClockWidget,
  Header,
  LiveIndicator,
  QRCodeWidget,
  Ticker,
  RelojLoopClock,
  RelojDigitalLoopClock,
  RelojClone
} from '../components';
import { OVERLAY_COMPONENTS } from '../models/components';

const STAGE_CLASS = 'relative min-h-screen bg-deep-sea';
const STAGE_CENTER_CLASS = 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-white';

export default function Preview() {
  const [activeDemo, setActiveDemo] = useState<string>('ticker');
  const [chyronText, setChyronText] = useState('LAS INTROS DEL FESTIVAL DE SANREMO');
  const [showChyron, setShowChyron] = useState(false);

  const renderDemo = () => {
    switch (activeDemo) {
      case 'ticker':
        return (
          <div className={STAGE_CLASS}>
            <div className={STAGE_CENTER_CLASS}>
              <p className='text-3xl'>Ticker Preview</p>
            </div>
            <Ticker hashtag='#ModoSanremoMR' url='modoradio.cl' />
          </div>
        );
      case 'chyron':
        return (
          <div className={STAGE_CLASS}>
            <Card className='absolute left-1/2 top-[30%] w-[92%] max-w-2xl -translate-x-1/2 -translate-y-1/2 space-y-3 bg-white/95 p-6 dark:bg-dark-sand/95'>
              <h2 className='text-xl font-semibold'>Chyron Preview</h2>
              <Input value={chyronText} onChange={(e) => setChyronText(e.target.value)} placeholder='Enter chyron text' />
              <Button onClick={() => setShowChyron(!showChyron)}>{showChyron ? 'Hide' : 'Show'} Chyron</Button>
            </Card>
            <Ticker hashtag='#ModoSanremoMR' url='modoradio.cl' />
            <ChyronHolder text={chyronText} show={showChyron} />
          </div>
        );
      case 'clock-widget':
        return (
          <div className={`${STAGE_CLASS} p-8`}>
            <ClockWidget />
            <div className={STAGE_CENTER_CLASS}>
              <p className='text-3xl'>Clock Widget Preview</p>
            </div>
          </div>
        );
      case 'qr-code':
        return (
          <div className={`${STAGE_CLASS} p-8`}>
            <QRCodeWidget content='https://modoradio.cl' />
            <div className={STAGE_CENTER_CLASS}>
              <p className='text-3xl'>QR Code Widget Preview</p>
            </div>
          </div>
        );
      case 'live-indicator':
        return (
          <div className={`${STAGE_CLASS} p-8`}>
            <LiveIndicator />
            <div className={STAGE_CENTER_CLASS}>
              <p className='text-3xl'>Live Indicator Preview</p>
            </div>
          </div>
        );
      case 'header':
        return (
          <div className={`${STAGE_CLASS} p-8`}>
            <Header title='ModoSanremo | La evolución gráfica del Festival' date='23/01/2026' />
            <div className={STAGE_CENTER_CLASS}>
              <p className='text-3xl'>Header Component Preview</p>
            </div>
          </div>
        );
      case 'reloj-loop-clock':
        return (
          <div className={`${STAGE_CLASS}`}>
            <RelojLoopClock />
          </div>
        );
      case 'reloj-digital-loop-clock':
        return (
          <div className={`${STAGE_CLASS}`}>
            <RelojDigitalLoopClock />
          </div>
        );
      case 'reloj-clone':
        return (
          <div className={`${STAGE_CLASS}`}>
            <RelojClone />
          </div>
        );
      default:
        return <div className='p-4 text-sm text-text-secondary'>Select a component to preview</div>;
    }
  };

  return (
    <div className='flex h-screen'>
      <aside className='w-[300px] overflow-y-auto border-r border-sand/30 bg-light-sand p-6 dark:border-sand/20 dark:bg-deep-sea'>
        <SectionHeader title='Component Preview' description='Preview each graphic block and its behavior.' />
        <div className='mt-6 flex flex-col gap-3'>
          {OVERLAY_COMPONENTS.map((demo) => (
            <Button
              key={demo.id}
              onClick={() => {
                setActiveDemo(demo.id);
                setShowChyron(false);
              }}
              variant={activeDemo === demo.id ? 'primary' : 'secondary'}
              className='h-auto justify-start px-4 py-3 text-left'
            >
              <div className='w-full'>
                <p className='font-semibold'>{demo.name}</p>
                <p className='mt-1 text-xs opacity-80'>{demo.description}</p>
              </div>
            </Button>
          ))}
        </div>
        <div className='mt-8 border-t border-sand/30 pt-4 dark:border-sand/20'>
          <Button
            type='button'
            className='w-full'
            onClick={() => {
              window.location.href = '/';
            }}
          >
            Back to Control Panel
          </Button>
        </div>
      </aside>

      <main className='relative flex-1 overflow-hidden'>{renderDemo()}</main>
    </div>
  );
}
