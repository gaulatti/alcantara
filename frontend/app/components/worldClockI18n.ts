// The world clock's city names (moved from programs/fifthbell/i18n.ts, gaulatti/alcantara#381).
export type SupportedLanguage = 'en' | 'es' | 'it';

const translations: Record<string, Record<SupportedLanguage, string>> = {
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
  }
};

export function t(key: string, language: SupportedLanguage): string {
  const translation = translations[key];
  if (!translation) return key;
  return translation[language] || translation.en || key;
}
