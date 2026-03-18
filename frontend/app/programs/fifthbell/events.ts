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

let cachedEvents: Event[] | null = null;
let lastFetchTime: Date | null = null;

export async function fetchEvents(): Promise<Event[]> {
  const eventsApiUrl = 'https://api.monitor.fifthbell.com/events';

  const response = await fetch(eventsApiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const newEvents = data.events || [];

  if (cachedEvents && cachedEvents.length > 0) {
    const eventMap = new Map<string, Event>();
    cachedEvents.forEach((event) => {
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

    cachedEvents = Array.from(eventMap.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  } else {
    cachedEvents = newEvents;
  }

  lastFetchTime = new Date();
  return cachedEvents;
}

export function getCachedEvents(): Event[] | null {
  return cachedEvents;
}

export function getLastFetchTime(): Date | null {
  return lastFetchTime;
}

export function clearCachedEvents(): void {
  cachedEvents = null;
  lastFetchTime = null;
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
