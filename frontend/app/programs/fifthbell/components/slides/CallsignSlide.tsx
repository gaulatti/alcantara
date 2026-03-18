import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FastAverageColor } from 'fast-average-color';
import { FIFTHBELL_ASSETS } from '../../assets';

interface CallsignSlideProps {
  currentTime: Date;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

const fac = new FastAverageColor();

export function CallsignSlide({ currentTime: initialTime }: CallsignSlideProps) {
  const [displayTime, setDisplayTime] = useState(initialTime);
  const [dominantColor, setDominantColor] = useState('#b21100');
  const [fullOpacity, setFullOpacity] = useState(1);
  const [smallOpacity, setSmallOpacity] = useState(0);
  const [centerOpacity, setCenterOpacity] = useState(0);
  const [showTime, setShowTime] = useState(false);
  const backgroundImage = FIFTHBELL_ASSETS.images.nyc;

  useEffect(() => {
    setDisplayTime(initialTime);
    const timer = window.setInterval(() => {
      setDisplayTime(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [initialTime]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFullOpacity(0);
      setSmallOpacity(1);
      setCenterOpacity(1);
      window.setTimeout(() => setShowTime(true), 500);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, []);

  const formatNyTime = (date: Date) =>
    date.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    try {
      const color = fac.getColor(event.currentTarget);
      setDominantColor(color.hex);
    } catch (error) {
      console.error('Error getting average color', error);
      setDominantColor('#b21100');
    }
  };

  return (
    <div className='absolute inset-0 animate-slide-transition'>
      <div className='absolute inset-0'>
        <img
          key={backgroundImage}
          src={backgroundImage}
          alt=''
          crossOrigin='anonymous'
          onLoad={handleImageLoad}
          className='w-full h-full object-cover blur-xl scale-105'
        />
      </div>

      <div
        className='absolute inset-0 opacity-75 mix-blend-multiply transition-all duration-1000'
        style={{ background: `linear-gradient(to bottom right, ${dominantColor}, #000000)` }}
      />

      <div className='absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.1),transparent_60%)]' />

      <div className='relative z-10 h-full flex flex-col items-center justify-center'>
        <div className='bg-[#b21100] text-white p-12 shadow-2xl mb-16 animate-scale-in' style={{ opacity: fullOpacity, transition: 'opacity 0.5s' }}>
          <BellRing size={256} strokeWidth={2} />
        </div>

        <div className='absolute top-4 left-4' style={{ opacity: smallOpacity, transition: 'opacity 0.5s' }}>
          <div className='bg-[#b21100] text-white p-6 shadow-lg scale-50'>
            <BellRing size={128} strokeWidth={2} />
          </div>
        </div>

        <div className='flex flex-col items-center' style={{ opacity: centerOpacity, transition: 'opacity 0.5s' }} />

        <div
          className="text-white text-6xl font-bold tracking-wider animate-fade-in-delay font-['JetBrains_Mono']"
          style={{ opacity: showTime ? 1 : 0, transition: 'opacity 0.5s' }}
        >
          {formatNyTime(displayTime)}
        </div>
        <div className='text-white text-3xl opacity-75 mt-4 animate-fade-in-delay' style={{ opacity: showTime ? 1 : 0, transition: 'opacity 0.5s' }}>
          This is fifth<span className='font-bold'>bell</span>.
        </div>
      </div>
    </div>
  );
}
