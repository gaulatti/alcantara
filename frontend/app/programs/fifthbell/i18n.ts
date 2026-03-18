export type SupportedLanguage = 'en' | 'es' | 'it';

interface Translations {
  [key: string]: {
    en: string;
    es: string;
    it: string;
  };
}

const translations: Translations = {
  'segment.articles': {
    en: 'News Articles',
    es: 'Artículos',
    it: 'Articoli'
  },
  'segment.weather': {
    en: 'Weather',
    es: 'Clima',
    it: 'Meteo'
  },
  'segment.earthquakes': {
    en: 'Earthquakes',
    es: 'Terremotos',
    it: 'Terremoti'
  },
  'segment.markets': {
    en: 'Markets',
    es: 'Mercados',
    it: 'Mercati'
  },
  'articles.noArticles': {
    en: 'No articles available',
    es: 'No hay artículos disponibles',
    it: 'Nessun articolo disponibile'
  },
  'weather.header': {
    en: 'WEATHER',
    es: 'CLIMA',
    it: 'METEO'
  },
  'weather.loading': {
    en: 'Loading weather data...',
    es: 'Cargando datos del clima...',
    it: 'Caricamento dati meteo...'
  },
  'weather.high': {
    en: 'High',
    es: 'Máx',
    it: 'Max'
  },
  'weather.low': {
    en: 'Low',
    es: 'Mín',
    it: 'Min'
  },
  'earthquakes.header': {
    en: 'RECENT EARTHQUAKES',
    es: 'TERREMOTOS RECIENTES',
    it: 'TERREMOTI RECENTI'
  },
  'earthquakes.subtitle': {
    en: 'Last 24 Hours • Magnitude 4.5+',
    es: 'Últimas 24 horas • Magnitud 4.5+',
    it: 'Ultime 24 ore • Magnitudo 4.5+'
  },
  'earthquakes.noData': {
    en: 'No significant earthquakes in the last 24 hours',
    es: 'No hay terremotos significativos en las últimas 24 horas',
    it: 'Nessun terremoto significativo nelle ultime 24 ore'
  },
  'earthquakes.loading': {
    en: 'Loading earthquake data...',
    es: 'Cargando datos de terremotos...',
    it: 'Caricamento dati terremoti...'
  },
  'earthquakes.depth': {
    en: 'km deep',
    es: 'km de profundidad',
    it: 'km di profondità'
  },
  'earthquakes.timeAgo.justNow': {
    en: 'Just now',
    es: 'Justo ahora',
    it: 'Proprio ora'
  },
  'earthquakes.timeAgo.minuteAgo': {
    en: '1 minute ago',
    es: 'Hace 1 minuto',
    it: '1 minuto fa'
  },
  'earthquakes.timeAgo.minutesAgo': {
    en: '{count} minutes ago',
    es: 'Hace {count} minutos',
    it: '{count} minuti fa'
  },
  'earthquakes.timeAgo.hourAgo': {
    en: '1 hour ago',
    es: 'Hace 1 hora',
    it: '1 ora fa'
  },
  'earthquakes.timeAgo.hoursAgo': {
    en: '{count} hours ago',
    es: 'Hace {count} horas',
    it: '{count} ore fa'
  },
  'earthquakes.timeAgo.dayAgo': {
    en: '1 day ago',
    es: 'Hace 1 día',
    it: '1 giorno fa'
  },
  'earthquakes.timeAgo.daysAgo': {
    en: '{count} days ago',
    es: 'Hace {count} días',
    it: '{count} giorni fa'
  },
  'markets.header': {
    en: 'MARKETS',
    es: 'MERCADOS',
    it: 'MERCATI'
  },
  'markets.subtitle': {
    en: 'Most Traded',
    es: 'Más Negociados',
    it: 'Più Scambiati'
  },
  'markets.loading': {
    en: 'Loading market data...',
    es: 'Cargando datos del mercado...',
    it: 'Caricamento dati di mercato...'
  },
  'markets.lastUpdate': {
    en: 'Last update: {time}',
    es: 'Última actualización: {time}',
    it: 'Ultimo aggiornamento: {time}'
  },
  'city.NEW YORK': {
    en: 'NEW YORK',
    es: 'NUEVA YORK',
    it: 'NEW YORK'
  },
  'city.LONDON': {
    en: 'LONDON',
    es: 'LONDRES',
    it: 'LONDRA'
  },
  'city.TOKYO': {
    en: 'TOKYO',
    es: 'TOKIO',
    it: 'TOKYO'
  },
  'city.SYDNEY': {
    en: 'SYDNEY',
    es: 'SÍDNEY',
    it: 'SYDNEY'
  },
  'city.ROME': {
    en: 'ROME',
    es: 'ROMA',
    it: 'ROMA'
  },
  'city.MADRID': {
    en: 'MADRID',
    es: 'MADRID',
    it: 'MADRID'
  },
  'city.LIMA': {
    en: 'LIMA',
    es: 'LIMA',
    it: 'LIMA'
  },
  'city.BERLIN': {
    en: 'BERLIN',
    es: 'BERLÍN',
    it: 'BERLINO'
  },
  'city.LOS ANGELES': {
    en: 'LOS ANGELES',
    es: 'LOS ÁNGELES',
    it: 'LOS ANGELES'
  },
  'city.MEXICO CITY': {
    en: 'MEXICO CITY',
    es: 'CIUDAD DE MÉXICO',
    it: 'CITTÀ DEL MESSICO'
  },
  'city.SANTIAGO': {
    en: 'SANTIAGO',
    es: 'SANTIAGO',
    it: 'SANTIAGO'
  },
  'city.BUENOS AIRES': {
    en: 'BUENOS AIRES',
    es: 'BUENOS AIRES',
    it: 'BUENOS AIRES'
  },
  'city.SÃO PAULO': {
    en: 'SÃO PAULO',
    es: 'SÃO PAULO',
    it: 'SAN PAOLO'
  },
  'city.HONOLULU': {
    en: 'HONOLULU',
    es: 'HONOLULU',
    it: 'HONOLULU'
  },
  'city.BEIJING': {
    en: 'BEIJING',
    es: 'PEKÍN',
    it: 'PECHINO'
  },
  'city.SINGAPORE': {
    en: 'SINGAPORE',
    es: 'SINGAPUR',
    it: 'SINGAPORE'
  },
  'city.DELHI': {
    en: 'DELHI',
    es: 'DELHI',
    it: 'DELHI'
  },
  'city.LAHORE': {
    en: 'LAHORE',
    es: 'LAHORE',
    it: 'LAHORE'
  },
  'city.MOSCOW': {
    en: 'MOSCOW',
    es: 'MOSCÚ',
    it: 'MOSCA'
  },
  'city.KYIV': {
    en: 'KYIV',
    es: 'KIEV',
    it: 'KIEV'
  },
  'city.CAIRO': {
    en: 'CAIRO',
    es: 'EL CAIRO',
    it: 'IL CAIRO'
  },
  'city.LAGOS': {
    en: 'LAGOS',
    es: 'LAGOS',
    it: 'LAGOS'
  },
  'city.CAPE TOWN': {
    en: 'CAPE TOWN',
    es: 'CIUDAD DEL CABO',
    it: 'CITTÀ DEL CAPO'
  },
  'city.NAIROBI': {
    en: 'NAIROBI',
    es: 'NAIROBI',
    it: 'NAIROBI'
  },
  'city.CASABLANCA': {
    en: 'CASABLANCA',
    es: 'CASABLANCA',
    it: 'CASABLANCA'
  },
  'region.North America': {
    en: 'North America',
    es: 'América del Norte',
    it: 'Nord America'
  },
  'region.Europe': {
    en: 'Europe',
    es: 'Europa',
    it: 'Europa'
  },
  'region.South America': {
    en: 'South America',
    es: 'América del Sur',
    it: 'Sud America'
  },
  'region.Asia': {
    en: 'Asia',
    es: 'Asia',
    it: 'Asia'
  }
};

export function t(key: string, language: SupportedLanguage, replacements?: Record<string, string | number>): string {
  const translation = translations[key];
  if (!translation) {
    console.warn(`Translation missing for key: ${key}`);
    return key;
  }

  let text = translation[language] || translation.en || key;

  if (replacements) {
    Object.entries(replacements).forEach(([placeholder, value]) => {
      text = text.replace(`{${placeholder}}`, String(value));
    });
  }

  return text;
}

export const LANGUAGE_ROTATION: SupportedLanguage[] = ['en', 'es', 'en', 'it'];

export function getNextLanguageIndex(currentIndex: number): number {
  return (currentIndex + 1) % LANGUAGE_ROTATION.length;
}
