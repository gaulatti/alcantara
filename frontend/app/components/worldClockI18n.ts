export type SupportedLanguage = 'en' | 'es' | 'it';

const CITY_TRANSLATIONS: Record<string, Record<SupportedLanguage, string>> = {
  'NEW YORK': { en: 'NEW YORK', es: 'NUEVA YORK', it: 'NEW YORK' },
  LONDON: { en: 'LONDON', es: 'LONDRES', it: 'LONDRA' },
  TOKYO: { en: 'TOKYO', es: 'TOKIO', it: 'TOKYO' },
  SYDNEY: { en: 'SYDNEY', es: 'SÍDNEY', it: 'SYDNEY' },
  ROME: { en: 'ROME', es: 'ROMA', it: 'ROMA' },
  MADRID: { en: 'MADRID', es: 'MADRID', it: 'MADRID' },
  LIMA: { en: 'LIMA', es: 'LIMA', it: 'LIMA' },
  BERLIN: { en: 'BERLIN', es: 'BERLÍN', it: 'BERLINO' },
  'LOS ANGELES': { en: 'LOS ANGELES', es: 'LOS ÁNGELES', it: 'LOS ANGELES' },
  'MEXICO CITY': { en: 'MEXICO CITY', es: 'CIUDAD DE MÉXICO', it: 'CITTÀ DEL MESSICO' },
  SANTIAGO: { en: 'SANTIAGO', es: 'SANTIAGO', it: 'SANTIAGO' },
  'BUENOS AIRES': { en: 'BUENOS AIRES', es: 'BUENOS AIRES', it: 'BUENOS AIRES' },
  'SÃO PAULO': { en: 'SÃO PAULO', es: 'SÃO PAULO', it: 'SAN PAOLO' },
  HONOLULU: { en: 'HONOLULU', es: 'HONOLULU', it: 'HONOLULU' },
  BEIJING: { en: 'BEIJING', es: 'PEKÍN', it: 'PECHINO' },
  SINGAPORE: { en: 'SINGAPORE', es: 'SINGAPUR', it: 'SINGAPORE' },
  DELHI: { en: 'DELHI', es: 'DELHI', it: 'DELHI' },
  LAHORE: { en: 'LAHORE', es: 'LAHORE', it: 'LAHORE' },
  MOSCOW: { en: 'MOSCOW', es: 'MOSCÚ', it: 'MOSCA' },
  KYIV: { en: 'KYIV', es: 'KIEV', it: 'KIEV' },
  CAIRO: { en: 'CAIRO', es: 'EL CAIRO', it: 'IL CAIRO' },
  LAGOS: { en: 'LAGOS', es: 'LAGOS', it: 'LAGOS' },
  'CAPE TOWN': { en: 'CAPE TOWN', es: 'CIUDAD DEL CABO', it: 'CITTÀ DEL CAPO' },
  NAIROBI: { en: 'NAIROBI', es: 'NAIROBI', it: 'NAIROBI' },
  CASABLANCA: { en: 'CASABLANCA', es: 'CASABLANCA', it: 'CASABLANCA' }
};

export function translateWorldClockCity(city: string, language: SupportedLanguage): string {
  return CITY_TRANSLATIONS[city]?.[language] ?? city;
}
