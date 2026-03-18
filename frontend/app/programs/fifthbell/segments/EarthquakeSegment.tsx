import { useState } from 'react';
import { AlertTriangle, Clock, Layers, Link, MapPin } from 'lucide-react';
import { FastAverageColor } from 'fast-average-color';
import { FIFTHBELL_ASSETS } from '../assets';
import type { Segment } from './types';
import { t, type SupportedLanguage } from '../i18n';

export interface EarthquakeData {
  id: number;
  magnitude: number;
  location: string;
  depth: number;
  time: string;
  timestamp: number;
  lat: number;
  lng: number;
  sources: string[];
  detailedPlace?: string;
}

interface ApiDatapoint {
  source: string;
  additionalData?: {
    place?: string;
    localPlace?: string;
  };
}

interface ApiEarthquake {
  id: number;
  magnitude: number;
  depth: number;
  timestamp: string;
  latitude: number;
  longitude: number;
  datapoints: ApiDatapoint[];
}

function formatTimeAgo(timestamp: number, language: SupportedLanguage = 'en'): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return diffDays === 1 ? t('earthquakes.timeAgo.dayAgo', language) : t('earthquakes.timeAgo.daysAgo', language, { count: diffDays });
  }
  if (diffHours > 0) {
    return diffHours === 1 ? t('earthquakes.timeAgo.hourAgo', language) : t('earthquakes.timeAgo.hoursAgo', language, { count: diffHours });
  }
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes > 0) {
    return diffMinutes === 1 ? t('earthquakes.timeAgo.minuteAgo', language) : t('earthquakes.timeAgo.minutesAgo', language, { count: diffMinutes });
  }
  return t('earthquakes.timeAgo.justNow', language);
}

export async function fetchEarthquakes(language: SupportedLanguage = 'en'): Promise<EarthquakeData[]> {
  try {
    const response = await fetch(`https://api.monitor.fifthbell.com/earthquakes?_=${Date.now()}`);
    if (!response.ok) {
      return [];
    }

    const data: ApiEarthquake[] = await response.json();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentQuakes = data
      .filter((quake) => quake.magnitude >= 4.5 && new Date(quake.timestamp).getTime() >= oneDayAgo)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 6);

    return recentQuakes.map((quake) => {
      const timestamp = new Date(quake.timestamp).getTime();
      let detailedPlace = '';
      const sources: string[] = [];

      quake.datapoints.forEach((datapoint) => {
        sources.push(datapoint.source);
        if (datapoint.additionalData?.place && !detailedPlace) {
          detailedPlace = datapoint.additionalData.place;
        } else if (datapoint.additionalData?.localPlace && !detailedPlace) {
          detailedPlace = datapoint.additionalData.localPlace;
        }
      });

      return {
        id: quake.id,
        magnitude: Math.round(quake.magnitude * 10) / 10,
        location: detailedPlace || `${quake.latitude.toFixed(2)}°, ${quake.longitude.toFixed(2)}°`,
        depth: Math.round(quake.depth),
        time: formatTimeAgo(timestamp, language),
        timestamp,
        lat: quake.latitude,
        lng: quake.longitude,
        sources: [...new Set(sources)],
        detailedPlace
      };
    });
  } catch (error) {
    console.error('Failed to fetch earthquake data:', error);
    return [];
  }
}

function getMagnitudeColor(magnitude: number): string {
  if (magnitude >= 7.0) return '#dc2626';
  if (magnitude >= 5.0) return '#eab308';
  return '#22c55e';
}

const fac = new FastAverageColor();

function EarthquakeSlide({ earthquakes, progress, language }: { earthquakes: EarthquakeData[]; progress: number; language: SupportedLanguage }) {
  const [dominantColor, setDominantColor] = useState('#7c2d12');
  const backgroundImage = FIFTHBELL_ASSETS.images.seismograph;

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    try {
      const color = fac.getColor(event.currentTarget);
      setDominantColor(color.hex);
    } catch (error) {
      console.error('Error getting average color', error);
      setDominantColor('#7c2d12');
    }
  };

  if (earthquakes.length === 0) {
    return (
      <div className='absolute inset-0'>
        <div className='absolute inset-0 opacity-75' style={{ background: 'linear-gradient(to bottom right, #7c2d12, #000000)' }} />
        <div className='relative z-10 h-full flex items-center justify-center'>
          <div className='text-4xl font-light'>{t('earthquakes.noData', language)}</div>
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
      <div className='absolute inset-0 opacity-75 mix-blend-multiply transition-all duration-1000' style={{ background: `linear-gradient(to bottom right, ${dominantColor}, #000000)` }} />
      <div className='absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.1),transparent_60%)]' />

      <div className='relative z-10 h-full flex flex-col justify-center px-24 py-24'>
        <div className='mb-8 animate-slide-up'>
          <div className='w-32 h-2 bg-white mb-8' />
          <div className='flex items-center space-x-4 mb-4'>
            <AlertTriangle size={56} className='text-orange-500' strokeWidth={2} />
            <h1 className="text-5xl font-bold tracking-tight leading-tight font-['Encode_Sans']">{t('earthquakes.header', language)}</h1>
          </div>
          <h2 className='text-2xl font-light opacity-90 leading-relaxed'>{t('earthquakes.subtitle', language)}</h2>
        </div>

        <div className='grid grid-cols-2 gap-6 animate-slide-up'>
          {earthquakes.map((quake, index) => {
            const baseColor = getMagnitudeColor(quake.magnitude);
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(baseColor);
            const rgb = result
              ? { r: Number.parseInt(result[1], 16), g: Number.parseInt(result[2], 16), b: Number.parseInt(result[3], 16) }
              : { r: 239, g: 68, b: 68 };

            let magnitudeIntensity;
            if (quake.magnitude < 5.0) {
              magnitudeIntensity = (quake.magnitude - 4.5) / 0.5;
            } else if (quake.magnitude < 7.0) {
              magnitudeIntensity = (quake.magnitude - 5.0) / 2.0;
            } else {
              magnitudeIntensity = Math.min((quake.magnitude - 7.0) / 1.0, 1);
            }

            const opacity = 0.15 + magnitudeIntensity * 0.35;
            const backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;

            return (
              <div key={quake.id} className='grid grid-cols-[auto_1fr] gap-x-12 items-center p-6 backdrop-blur-sm rounded-lg border border-white/5' style={{ animationDelay: `${index * 0.05}s`, backgroundColor }}>
                <div className='flex flex-col items-center' style={{ width: '100px' }}>
                  <div className='text-5xl font-bold leading-none'>M{quake.magnitude.toFixed(1)}</div>
                </div>
                <div className='flex flex-col justify-center min-w-0'>
                  <h3 className="text-3xl font-bold mb-2 line-clamp-2 leading-tight font-['Encode_Sans']" title={quake.location}>
                    {quake.location}
                  </h3>
                  <div className='grid grid-cols-2 gap-x-4 gap-y-1.5 text-xl'>
                    <div className='flex items-center space-x-2'>
                      <Clock size={16} className='opacity-70 shrink-0' />
                      <span className='truncate'>{quake.time}</span>
                    </div>
                    <div className='flex items-center space-x-2'>
                      <Layers size={16} className='opacity-70 shrink-0' />
                      <span className='truncate'>{quake.depth} {t('earthquakes.depth', language)}</span>
                    </div>
                    <div className='flex items-center space-x-2 opacity-80'>
                      <MapPin size={16} className='opacity-70 shrink-0' />
                      <span className='truncate'>{quake.lat.toFixed(2)}°, {quake.lng.toFixed(2)}°</span>
                    </div>
                    {quake.sources.length > 0 && (
                      <div className='flex items-center space-x-2 opacity-80'>
                        <Link size={16} className='opacity-70 shrink-0' />
                        <span className='truncate'>{quake.sources.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className='absolute bottom-24 left-24 right-24 h-1 bg-white/30'>
          <div className='h-full bg-white transition-all duration-100 ease-linear' style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}

function EarthquakeLoadingSlide({ language }: { language: SupportedLanguage }) {
  return (
    <div className='absolute inset-0'>
      <div className='absolute inset-0 opacity-75' style={{ background: 'linear-gradient(to bottom right, #7c2d12, #000000)' }} />
      <div className='relative z-10 h-full flex items-center justify-center'>
        <div className='text-4xl font-light animate-pulse'>{t('earthquakes.loading', language)}</div>
      </div>
    </div>
  );
}

export function createEarthquakeSegment(
  earthquakes: EarthquakeData[],
  onDataUpdate?: (data: EarthquakeData[]) => void,
  language: SupportedLanguage = 'en'
): Segment {
  return {
    id: 'earthquakes',
    label: t('segment.earthquakes', language),
    itemCount: 1,
    durationMsPerItem: 10000,
    render: (itemIndex: number, progress: number) =>
      earthquakes.length === 0 ? (
        <EarthquakeLoadingSlide key='earthquake-loading' language={language} />
      ) : (
        <EarthquakeSlide key={`earthquake-${itemIndex}`} earthquakes={earthquakes} progress={progress} language={language} />
      ),
    prefetch: async () => {
      if (!onDataUpdate) {
        return;
      }
      onDataUpdate(await fetchEarthquakes(language));
    }
  };
}
