import { TIMEZONE_LINKS } from './timezoneAliases';

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

export interface TimezoneOption {
  value: string;
  label: string;
}

/**
 * The browser's own id for `timezone`: Intl resolves an alias such as
 * America/Argentina/Buenos_Aires to the name it lists (America/Buenos_Aires
 * in Chromium). Used only to compare ids; it is never stored. An id the
 * browser does not know is returned unchanged.
 */
/** The tz database zone that `timezone` names, through its links. */
function getLinkedZone(timezone: string): string {
  return TIMEZONE_LINKS[timezone] ?? timezone;
}

function getBrowserTimezoneId(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return timezone;
  }
}

/**
 * Returns the picker options with `value` kept selectable as exactly one
 * option. The options list the zones the browser's Intl reports, which may
 * spell a saved or default zone differently (Chromium lists
 * America/Buenos_Aires and Asia/Calcutta for the saved
 * America/Argentina/Buenos_Aires and Asia/Kolkata). The option for the same
 * zone then carries the saved id, and its name when the id names a city, so
 * the picker shows it selected and saving keeps the stored id. Ids are
 * matched through Intl first and then through the tz database's links
 * (TIMEZONE_LINKS), for engines such as WebKit whose Intl links neither
 * spelling. A zone the list lacks under any name is listed first. The saved
 * id is never rewritten.
 */
export function withTimezoneOption(options: TimezoneOption[], value: string, date: Date = new Date()): TimezoneOption[] {
  if (!value || options.some((option) => option.value === value)) {
    return options;
  }
  const browserId = getBrowserTimezoneId(value);
  let aliasIndex = options.findIndex((option) => option.value === browserId);
  if (aliasIndex < 0) {
    // Intl linked nothing (WebKit resolves both spellings to themselves):
    // compare through the tz database's links instead.
    const zone = getLinkedZone(value);
    aliasIndex = options.findIndex((option) => getLinkedZone(option.value) === zone);
  }
  if (aliasIndex >= 0) {
    // A saved id that names a city keeps its own name (Kyiv, not Kiev); a
    // POSIX id such as EST5EDT keeps the listed city's label.
    const label = value.includes('/') ? getTimezoneOptionLabel(value, date) : options[aliasIndex].label;
    return options.map((option, index) => (index === aliasIndex ? { value, label } : option));
  }
  return [{ value, label: getTimezoneOptionLabel(value, date) }, ...options];
}
