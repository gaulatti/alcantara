import { useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { FastAverageColor } from 'fast-average-color';
import { FIFTHBELL_ASSETS } from '../assets';
import type { Segment } from './types';
import { t, type SupportedLanguage } from '../i18n';

export interface MarketData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

interface ApiMarketData {
  symbol: string;
  price: number;
  name: string;
  change: number;
  changesPercentage: number;
}

let marketCache: { data: MarketData[]; timestamp: number; updateTime: string } | null = null;
const CACHE_DURATION_MS = 15 * 60 * 1000;

export async function fetchMarketData(): Promise<MarketData[]> {
  const now = Date.now();
  if (marketCache && now - marketCache.timestamp < CACHE_DURATION_MS) {
    return marketCache.data;
  }

  try {
    const response = await fetch(`https://financialmodelingprep.com/stable/most-actives?apikey=a8mpam9ffQSf9ROfBBKovbPHRw25qtNH&_=${Date.now()}`);
    if (!response.ok) {
      return marketCache?.data || [];
    }

    const data: ApiMarketData[] = await response.json();
    const marketData = data
      .filter((stock) => stock.price > 1 && Math.abs(stock.changesPercentage) < 200)
      .sort((a, b) => Math.abs(b.changesPercentage) - Math.abs(a.changesPercentage))
      .slice(0, 6)
      .map((stock) => ({
        symbol: stock.symbol,
        name: stock.name,
        price: stock.price,
        change: stock.change,
        changePercent: stock.changesPercentage
      }));

    marketCache = {
      data: marketData,
      timestamp: now,
      updateTime: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };

    return marketData;
  } catch (error) {
    console.error('[MarketsSegment] Failed to fetch market data:', error);
    return marketCache?.data || [];
  }
}

export function getLastUpdateTime(): string {
  return marketCache?.updateTime || '--:--';
}

const fac = new FastAverageColor();

function MarketSlide({ progress, marketData, language }: { progress: number; marketData: MarketData[]; language: SupportedLanguage }) {
  const [dominantColor, setDominantColor] = useState('#065f46');
  const backgroundImage = FIFTHBELL_ASSETS.images.nyse;

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    try {
      const color = fac.getColor(event.currentTarget);
      setDominantColor(color.hex);
    } catch (error) {
      console.error('Error getting average color', error);
      setDominantColor('#065f46');
    }
  };

  if (marketData.length === 0) {
    return (
      <div className='absolute inset-0'>
        <div className='absolute inset-0 opacity-75' style={{ background: 'linear-gradient(to bottom right, #065f46, #000000)' }} />
        <div className='relative z-10 h-full flex items-center justify-center'>
          <div className='text-4xl font-light animate-pulse'>{t('markets.loading', language)}</div>
        </div>
      </div>
    );
  }

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

      <div className='relative z-10 h-full flex flex-col justify-center px-24'>
        <div className='mb-12 animate-slide-up'>
          <div className='w-32 h-2 bg-white mb-12' />
          <h1 className="text-5xl font-bold tracking-tight mb-8 leading-tight font-['Encode_Sans']">{t('markets.header', language)}</h1>
          <h2 className='text-3xl font-light opacity-90 leading-relaxed'>{t('markets.subtitle', language)}</h2>
        </div>

        <div className='grid grid-cols-2 gap-4 animate-slide-up'>
          {marketData.map((stock, index) => {
            const isPositive = stock.change >= 0;
            const changeColor = isPositive ? 'text-green-400' : 'text-red-400';
            const Icon = isPositive ? TrendingUp : TrendingDown;
            const logIntensity = Math.log10(1 + Math.abs(stock.changePercent)) / Math.log10(1 + 100);
            const opacity = 0.15 + Math.min(logIntensity, 1) * 0.35;
            const backgroundColor = isPositive ? `rgba(34, 197, 94, ${opacity})` : `rgba(239, 68, 68, ${opacity})`;

            return (
              <div
                key={stock.symbol}
                className='grid grid-cols-2 gap-x-12 items-center p-6 backdrop-blur-sm rounded-lg border border-white/5'
                style={{ animationDelay: `${index * 0.05}s`, backgroundColor }}
              >
                <div className='flex flex-col'>
                  <span className="text-4xl font-bold mb-1 font-['Encode_Sans']">{stock.symbol}</span>
                  <span className='text-2xl opacity-70'>{stock.name}</span>
                </div>
                <div className='flex flex-col items-end'>
                  <div className="text-5xl font-bold mb-1 font-['Encode_Sans']">${stock.price.toFixed(2)}</div>
                  <div className={`flex items-center space-x-2 ${changeColor}`}>
                    <Icon size={24} strokeWidth={2} />
                    <span className='text-3xl font-bold'>
                      {isPositive ? '+' : ''}
                      {stock.change.toFixed(2)}
                    </span>
                    <span className='text-2xl opacity-80'>
                      ({isPositive ? '+' : ''}
                      {stock.changePercent.toFixed(2)}%)
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className='mt-6 mb-24 text-xl opacity-60 animate-fade-in-delay'>
          <p>{t('markets.lastUpdate', language, { time: getLastUpdateTime() })}</p>
        </div>

        <div className='absolute bottom-24 left-24 right-24 h-1 bg-white/30'>
          <div className='h-full bg-white transition-all duration-100 ease-linear' style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}

export function createMarketsSegment(marketData: MarketData[], onDataUpdate?: (data: MarketData[]) => void, language: SupportedLanguage = 'en'): Segment {
  return {
    id: 'markets',
    label: t('segment.markets', language),
    itemCount: 1,
    durationMsPerItem: 10000,
    render: (itemIndex: number, progress: number) => (
      <MarketSlide key={`market-${itemIndex}`} progress={progress} marketData={marketData} language={language} />
    ),
    prefetch: async () => {
      if (!onDataUpdate) {
        return;
      }
      onDataUpdate(await fetchMarketData());
    }
  };
}
