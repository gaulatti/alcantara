import type { SupportedLanguage } from './i18n';

export interface EventPost {
  id: number;
  uuid: string;
  content: string;
  source: string;
  uri: string;
  hash: string;
  author: string;
  createdAt: string;
  relevance: number;
  match_score: number;
}

export interface Event {
  id: number;
  uuid: string;
  title: string;
  summary: string;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  posts_count: number;
  posts: EventPost[];
}

interface EventsResponse {
  events: Event[];
  total: number;
}

interface EventWithLanguage extends Event {
  language?: unknown;
  lang?: unknown;
  locale?: unknown;
}

interface EventPostWithLanguage extends EventPost {
  language?: unknown;
  lang?: unknown;
  locale?: unknown;
}

interface FetchEventsOptions {
  language?: SupportedLanguage;
  allowedLanguages?: SupportedLanguage[];
}

interface EventCacheEntry {
  events: Event[];
  lastFetchTime: Date;
}

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(['en', 'es', 'it']);
const eventCacheByKey = new Map<string, EventCacheEntry>();
let activeCacheKey = '__default__';

function normalizeLanguageToken(value: unknown): SupportedLanguage | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.split('-')[0] as SupportedLanguage;
  if (!SUPPORTED_LANGUAGE_SET.has(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeAllowedLanguages(value: SupportedLanguage[] | undefined): SupportedLanguage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<SupportedLanguage>();
  for (const item of value) {
    const normalized = normalizeLanguageToken(item);
    if (normalized) {
      deduped.add(normalized);
    }
  }

  return [...deduped];
}

function getEventLanguage(event: Event): SupportedLanguage | null {
  const eventRecord = event as EventWithLanguage;
  const direct = normalizeLanguageToken(eventRecord.language) ?? normalizeLanguageToken(eventRecord.lang) ?? normalizeLanguageToken(eventRecord.locale);
  if (direct) {
    return direct;
  }

  for (const post of event.posts || []) {
    const postRecord = post as EventPostWithLanguage;
    const postLanguage = normalizeLanguageToken(postRecord.language) ?? normalizeLanguageToken(postRecord.lang) ?? normalizeLanguageToken(postRecord.locale);
    if (postLanguage) {
      return postLanguage;
    }
  }

  return null;
}

function filterEventsByLanguage(events: Event[], allowedLanguages: SupportedLanguage[]): Event[] {
  if (allowedLanguages.length === 0) {
    return events;
  }

  const allowed = new Set<SupportedLanguage>(allowedLanguages);
  return events.filter((event) => {
    const eventLanguage = getEventLanguage(event);
    if (!eventLanguage) {
      return true;
    }
    return allowed.has(eventLanguage);
  });
}

function buildCacheKey(language: SupportedLanguage | undefined, allowedLanguages: SupportedLanguage[]): string {
  const languagePart = language ?? 'any';
  const allowedPart = allowedLanguages.length > 0 ? [...allowedLanguages].sort().join(',') : 'all';
  return `${languagePart}__${allowedPart}`;
}

export async function fetchEvents(options: FetchEventsOptions = {}): Promise<Event[]> {
  const allowedLanguages = normalizeAllowedLanguages(options.allowedLanguages);
  const preferredLanguage = normalizeLanguageToken(options.language);
  const cacheKey = buildCacheKey(preferredLanguage ?? undefined, allowedLanguages);
  const eventsApiUrl = new URL('https://api.monitor.gaulatti.com/events');
  if (preferredLanguage) {
    eventsApiUrl.searchParams.set('language', preferredLanguage);
  }

  const response = await fetch(eventsApiUrl.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const newEvents = filterEventsByLanguage(data.events || [], allowedLanguages);
  const previousCacheEntry = eventCacheByKey.get(cacheKey);
  const previousEvents = previousCacheEntry?.events ?? null;

  let nextEvents: Event[];

  if (previousEvents && previousEvents.length > 0) {
    const eventMap = new Map<string, Event>();
    previousEvents.forEach((event) => {
      eventMap.set(event.uuid, event);
    });

    newEvents.forEach((newEvent) => {
      const existingEvent = eventMap.get(newEvent.uuid);
      if (!existingEvent) {
        eventMap.set(newEvent.uuid, newEvent);
        return;
      }

      const postMap = new Map<string, EventPost>();
      existingEvent.posts.forEach((post) => {
        postMap.set(post.uuid, post);
      });
      newEvent.posts.forEach((post) => {
        postMap.set(post.uuid, post);
      });

      eventMap.set(newEvent.uuid, {
        ...existingEvent,
        title: newEvent.title,
        summary: newEvent.summary,
        status: newEvent.status,
        updated_at: newEvent.updated_at,
        posts_count: newEvent.posts_count,
        posts: Array.from(postMap.values()).sort((a, b) => b.relevance - a.relevance)
      });
    });

    nextEvents = Array.from(eventMap.values()).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  } else {
    nextEvents = newEvents;
  }

  const nextFetchTime = new Date();
  eventCacheByKey.set(cacheKey, {
    events: nextEvents,
    lastFetchTime: nextFetchTime
  });
  activeCacheKey = cacheKey;

  return nextEvents;
}

export function getCachedEvents(): Event[] | null {
  return eventCacheByKey.get(activeCacheKey)?.events ?? null;
}

export function getLastFetchTime(): Date | null {
  return eventCacheByKey.get(activeCacheKey)?.lastFetchTime ?? null;
}

export function clearCachedEvents(): void {
  eventCacheByKey.clear();
  activeCacheKey = '__default__';
}

export function hasEventChanges(oldEvents: Event[], newEvents: Event[]): boolean {
  if (oldEvents.length !== newEvents.length) {
    return true;
  }

  const oldMap = new Map(oldEvents.map((event) => [event.uuid, event]));
  const newMap = new Map(newEvents.map((event) => [event.uuid, event]));

  for (const uuid of newMap.keys()) {
    if (!oldMap.has(uuid)) {
      return true;
    }
  }

  for (const uuid of oldMap.keys()) {
    if (!newMap.has(uuid)) {
      return true;
    }
  }

  for (const [uuid, newEvent] of newMap.entries()) {
    const oldEvent = oldMap.get(uuid);
    if (!oldEvent) {
      continue;
    }

    if (
      oldEvent.title !== newEvent.title ||
      oldEvent.status !== newEvent.status ||
      oldEvent.posts_count !== newEvent.posts_count ||
      oldEvent.posts.length !== newEvent.posts.length
    ) {
      return true;
    }

    const oldPostMap = new Map(oldEvent.posts.map((post) => [post.uuid, post]));
    for (const post of newEvent.posts) {
      if (!oldPostMap.has(post.uuid)) {
        return true;
      }
    }
  }

  return false;
}
