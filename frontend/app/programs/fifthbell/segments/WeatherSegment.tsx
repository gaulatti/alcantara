import { useEffect, useState } from 'react';
import { Cloud, CloudRain, Sun, Wind } from 'lucide-react';
import { FastAverageColor } from 'fast-average-color';
import { FIFTHBELL_ASSETS } from '../assets';
import type { Segment } from './types';
import { t, type SupportedLanguage } from '../i18n';

export interface WeatherCityData {
  name: string;
  temp: number;
  condition: 'sunny' | 'cloudy' | 'rainy' | 'windy';
  high: number;
  low: number;
}

export interface WeatherRegionData {
  region: string;
  cities: WeatherCityData[];
}

const CITY_LOCATIONS = {
  'New York': { lat: 40.7128, lon: -74.006 },
  'San Juan': { lat: 18.4655, lon: -66.1057 },
  'Los Angeles': { lat: 34.0522, lon: -118.2437 },
  Honolulu: { lat: 21.3099, lon: -157.8581 },
  'Mexico City': { lat: 19.4326, lon: -99.1332 },
  Havana: { lat: 23.1136, lon: -82.3666 },
  London: { lat: 51.5074, lon: -0.1278 },
  Paris: { lat: 48.8566, lon: 2.3522 },
  Berlin: { lat: 52.52, lon: 13.405 },
  Rome: { lat: 41.9028, lon: 12.4964 },
  Madrid: { lat: 40.4168, lon: -3.7038 },
  Athens: { lat: 37.9838, lon: 23.7275 },
  Santiago: { lat: -33.4489, lon: -70.6693 },
  'Buenos Aires': { lat: -34.6037, lon: -58.3816 },
  Rio: { lat: -22.9068, lon: -43.1729 },
  Lima: { lat: -12.0464, lon: -77.0428 },
  Caracas: { lat: 10.4806, lon: -66.9036 },
  Bogotá: { lat: 4.711, lon: -74.0721 },
  Tokyo: { lat: 35.6762, lon: 139.6503 },
  Seoul: { lat: 37.5665, lon: 126.978 },
  Shanghai: { lat: 31.2304, lon: 121.4737 },
  'Hong Kong': { lat: 22.3193, lon: 114.1694 },
  Bangkok: { lat: 13.7563, lon: 100.5018 },
  Jakarta: { lat: -6.2088, lon: 106.8456 }
} as const;

const REGIONS = [
  { region: 'North America', cities: ['New York', 'San Juan', 'Los Angeles', 'Honolulu', 'Mexico City', 'Havana'] },
  { region: 'Europe', cities: ['Rome', 'Berlin', 'Paris', 'Madrid', 'London', 'Athens'] },
  { region: 'South America', cities: ['Santiago', 'Buenos Aires', 'Rio', 'Lima', 'Caracas', 'Bogotá'] },
  { region: 'Asia', cities: ['Tokyo', 'Seoul', 'Shanghai', 'Hong Kong', 'Bangkok', 'Jakarta'] }
] as const;

function getWeatherCondition(weatherCode: number): 'sunny' | 'cloudy' | 'rainy' | 'windy' {
  if (weatherCode === 0 || weatherCode === 1) return 'sunny';
  if (weatherCode === 2 || weatherCode === 3) return 'cloudy';
  if (weatherCode >= 51 && weatherCode <= 67) return 'rainy';
  if (weatherCode >= 71 && weatherCode <= 86) return 'rainy';
  if (weatherCode >= 95) return 'rainy';
  return 'cloudy';
}

async function fetchCityWeather(cityName: string): Promise<WeatherCityData | null> {
  const location = CITY_LOCATIONS[cityName as keyof typeof CITY_LOCATIONS];
  if (!location) return null;

  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      name: cityName,
      temp: Math.round(data.current.temperature_2m),
      condition: getWeatherCondition(data.current.weather_code),
      high: Math.round(data.daily.temperature_2m_max[0]),
      low: Math.round(data.daily.temperature_2m_min[0])
    };
  } catch (error) {
    console.error(`Failed to fetch weather for ${cityName}:`, error);
    return null;
  }
}

let weatherCache: { data: WeatherRegionData[]; timestamp: number } | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000;

export async function fetchWeatherData(): Promise<WeatherRegionData[]> {
  const now = Date.now();
  if (weatherCache && now - weatherCache.timestamp < CACHE_DURATION_MS) {
    return weatherCache.data;
  }

  const results: WeatherRegionData[] = [];
  for (const regionDef of REGIONS) {
    const cityResults = await Promise.all(regionDef.cities.map((city) => fetchCityWeather(city)));
    const cities = cityResults.filter((city): city is WeatherCityData => city !== null);
    if (cities.length > 0) {
      results.push({ region: regionDef.region, cities });
    }
  }

  weatherCache = { data: results, timestamp: now };
  return results;
}

function getWeatherIcon(condition: string, size = 48) {
  const iconProps = { size, strokeWidth: 2 };
  switch (condition) {
    case 'sunny':
      return <Sun {...iconProps} className='text-yellow-400' />;
    case 'rainy':
      return <CloudRain {...iconProps} className='text-blue-400' />;
    case 'windy':
      return <Wind {...iconProps} className='text-gray-400' />;
    default:
      return <Cloud {...iconProps} className='text-gray-300' />;
  }
}

function fahrenheitToCelsius(value: number): number {
  return Math.round(((value - 32) * 5) / 9);
}

function getRegionBackground(region: string): string {
  switch (region) {
    case 'North America':
      return FIFTHBELL_ASSETS.images.nyc;
    case 'Europe':
      return FIFTHBELL_ASSETS.images.berlin;
    case 'South America':
      return FIFTHBELL_ASSETS.images.santiago;
    case 'Asia':
      return FIFTHBELL_ASSETS.images.tokyo;
    default:
      return '';
  }
}

const fac = new FastAverageColor();

interface WeatherSlideProps {
  weatherData: WeatherRegionData;
  progress: number;
  unit: 'fahrenheit' | 'celsius';
  language: SupportedLanguage;
}

function WeatherSlide({ weatherData, progress, unit, language }: WeatherSlideProps) {
  const [dominantColor, setDominantColor] = useState('#1e40af');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [displayUnit, setDisplayUnit] = useState(unit);
  const backgroundImage = getRegionBackground(weatherData.region);
  const unitLabel = displayUnit === 'fahrenheit' ? '°F' : '°C';

  useEffect(() => {
    if (unit !== displayUnit) {
      setIsTransitioning(true);
      const timer = window.setTimeout(() => {
        setDisplayUnit(unit);
        setIsTransitioning(false);
      }, 300);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [unit, displayUnit]);

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    try {
      const color = fac.getColor(event.currentTarget);
      setDominantColor(color.hex);
    } catch (error) {
      console.error('Error getting average color', error);
      setDominantColor('#1e40af');
    }
  };

  return (
    <div className='absolute inset-0 animate-slide-transition'>
      {backgroundImage && (
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
      )}

      <div
        className='absolute inset-0 opacity-75 mix-blend-multiply transition-all duration-1000'
        style={{ background: `linear-gradient(to bottom right, ${dominantColor}, #000000)` }}
      />
      <div className='absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.1),transparent_60%)]' />

      <div className='relative z-10 h-full flex flex-col justify-center px-24'>
        <div className='mb-12 animate-slide-up'>
          <div className='w-32 h-2 bg-white mb-12' />
          <h1 className="text-5xl font-bold tracking-tight mb-8 leading-tight font-['Encode_Sans']">{t('weather.header', language)}</h1>
          <h2 className='text-3xl font-light opacity-90 leading-relaxed'>{t(`region.${weatherData.region}`, language)}</h2>
        </div>

        <div className='grid grid-cols-2 gap-8 animate-slide-up'>
          {weatherData.cities.map((city, index) => {
            const temp = displayUnit === 'celsius' ? fahrenheitToCelsius(city.temp) : city.temp;
            const high = displayUnit === 'celsius' ? fahrenheitToCelsius(city.high) : city.high;
            const low = displayUnit === 'celsius' ? fahrenheitToCelsius(city.low) : city.low;

            return (
              <div key={city.name} className='flex items-center space-x-6 p-6 bg-white/10 backdrop-blur-sm rounded-lg' style={{ animationDelay: `${index * 0.1}s` }}>
                <div className='shrink-0'>{getWeatherIcon(city.condition, 48)}</div>
                <div className='flex-1'>
                  <h3 className="text-3xl font-bold mb-2 font-['Encode_Sans']">{city.name}</h3>
                  <span className="text-5xl font-bold transition-opacity duration-300 font-['Encode_Sans']" style={{ opacity: isTransitioning ? 0 : 1 }}>
                    {temp}
                    {unitLabel}
                  </span>
                </div>
                <div className='flex flex-col items-end space-y-1'>
                  <span className='text-2xl opacity-70 transition-opacity duration-300' style={{ opacity: isTransitioning ? 0 : 0.7 }}>
                    {t('weather.high', language)} {high}
                    {unitLabel}
                  </span>
                  <span className='text-2xl opacity-70 transition-opacity duration-300' style={{ opacity: isTransitioning ? 0 : 0.7 }}>
                    {t('weather.low', language)} {low}
                    {unitLabel}
                  </span>
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

function WeatherLoadingSlide({ language }: { language: SupportedLanguage }) {
  return (
    <div className='absolute inset-0'>
      <div className='absolute inset-0 opacity-75' style={{ background: 'linear-gradient(to bottom right, #1e40af, #000000)' }} />
      <div className='relative z-10 h-full flex items-center justify-center'>
        <div className='text-4xl font-light animate-pulse'>{t('weather.loading', language)}</div>
      </div>
    </div>
  );
}

export function createWeatherSegment(
  weatherData: WeatherRegionData[],
  onDataUpdate?: (data: WeatherRegionData[]) => void,
  language: SupportedLanguage = 'en'
): Segment {
  return {
    id: 'weather',
    label: t('segment.weather', language),
    get itemCount() {
      return weatherData.length > 0 ? weatherData.length * 2 : 8;
    },
    durationMsPerItem: 5000,
    render: (itemIndex: number, progress: number) => {
      if (weatherData.length === 0) {
        return <WeatherLoadingSlide key='weather-loading' language={language} />;
      }

      const regionIndex = Math.floor(itemIndex / 2) % weatherData.length;
      const unit = itemIndex % 2 === 0 ? 'fahrenheit' : 'celsius';
      return (
        <WeatherSlide
          key={`weather-${regionIndex}`}
          weatherData={weatherData[regionIndex]}
          progress={progress}
          unit={unit}
          language={language}
        />
      );
    },
    prefetch: async () => {
      if (!onDataUpdate) {
        return;
      }
      onDataUpdate(await fetchWeatherData());
    }
  };
}
