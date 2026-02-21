const FALLBACK_TIMEZONES = [
  'UTC',
  'America/Argentina/Buenos_Aires',
  'America/New_York',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
];

export function getSupportedTimezones(): string[] {
  const intlWithSupportedValuesOf = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };

  try {
    const zones = intlWithSupportedValuesOf.supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) {
      return zones;
    }
  } catch {
    // Ignore and use fallback list.
  }

  return FALLBACK_TIMEZONES;
}

function parseOffsetToMinutes(offsetLabel: string): number {
  if (offsetLabel === 'GMT') return 0;

  const match = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || '0');
  return sign * (hours * 60 + minutes);
}

function getCityLabel(timezone: string): string {
  if (timezone === 'UTC') return 'UTC';

  const parts = timezone.split('/');
  const city = parts[parts.length - 1] || timezone;
  return city.replace(/_/g, ' ');
}

function getOffsetLabel(timezone: string, date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
    if (offset) {
      return offset.replace('UTC', 'GMT');
    }
  } catch {
    // Ignore and use fallback below.
  }

  return 'GMT';
}

export function getTimezoneOptionLabel(timezone: string, date: Date = new Date()): string {
  return `${getCityLabel(timezone)} (${getOffsetLabel(timezone, date)})`;
}

export function getTimezonesSortedByOffset(date: Date = new Date()): string[] {
  const timezones = getSupportedTimezones();

  const withMeta = timezones.map((timezone) => {
    const offsetLabel = getOffsetLabel(timezone, date);
    return {
      timezone,
      offsetMinutes: parseOffsetToMinutes(offsetLabel),
      label: `${getCityLabel(timezone)} (${offsetLabel})`,
    };
  });

  withMeta.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) {
      return a.offsetMinutes - b.offsetMinutes;
    }
    return a.label.localeCompare(b.label);
  });

  return withMeta.map((item) => item.timezone);
}
