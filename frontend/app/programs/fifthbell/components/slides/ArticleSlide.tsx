import { useMemo, useState } from 'react';
import { FastAverageColor } from 'fast-average-color';

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  imageUrl: string;
  category?: string;
  url: string;
}

interface ArticleSlideProps {
  newsItem: NewsItem;
  progress: number;
}

const fac = new FastAverageColor();

function buildQrCodeUrl(value: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(value)}`;
}

export function ArticleSlide({ newsItem, progress }: ArticleSlideProps) {
  const [dominantColor, setDominantColor] = useState('#b21100');
  const imageUrl = newsItem.imageUrl || 'https://picsum.photos/seed/fallback/1920/1080';
  const qrCodeUrl = useMemo(() => buildQrCodeUrl(newsItem.url), [newsItem.url]);

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    try {
      const color = fac.getColor(event.currentTarget);
      setDominantColor(color.hex);
    } catch (error) {
      console.error('Error getting average color', error);
    }
  };

  return (
    <div className='absolute inset-0'>
      <div className='absolute inset-0'>
        <img
          key={imageUrl}
          src={imageUrl}
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

      <div className='relative z-10 grid grid-cols-12 h-full'>
        <div className='col-span-5 flex flex-col justify-center px-24 relative'>
          <div className='w-32 h-2 bg-white mb-12' />

          <div key={newsItem.id} className='animate-slide-up'>
            <h1 className="text-5xl font-bold leading-tight mb-8 tracking-tight line-clamp-6 font-['Encode_Sans']">{newsItem.headline}</h1>
            <p className="text-4xl font-light leading-relaxed opacity-90 line-clamp-6 font-['Libre_Franklin']">{newsItem.summary}</p>
          </div>

          {newsItem.category && (
            <div key={`${newsItem.id}-cat`} className='absolute bottom-40 left-24 animate-slide-up'>
              <span className='text-white px-4 py-2 text-2xl font-bold uppercase tracking-wider' style={{ backgroundColor: dominantColor }}>
                {newsItem.category}
              </span>
            </div>
          )}
        </div>

        <div className='col-span-7 relative h-full flex items-center justify-center p-16 pb-40'>
          <div className='relative w-full aspect-video shadow-2xl overflow-hidden border-4 border-white/10'>
            <div className='absolute top-0 left-0 h-1 bg-white/30 w-full z-20'>
              <div className='h-full bg-white transition-all duration-100 ease-linear' style={{ width: `${progress}%` }} />
            </div>
            <img
              key={imageUrl}
              src={imageUrl}
              alt={newsItem.headline}
              className='w-full h-full object-cover'
              style={{ animation: 'kenburns 20s infinite alternate' }}
            />
          </div>
        </div>
      </div>

      <div className='absolute bottom-24 left-0 w-full flex justify-between items-end px-24 z-50'>
        <div className='ml-auto p-2 bg-white/10 backdrop-blur-sm'>
          <img src={qrCodeUrl} alt='Article QR code' className='block w-37.5 h-37.5' />
        </div>
      </div>
    </div>
  );
}
