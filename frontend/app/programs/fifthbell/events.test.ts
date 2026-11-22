import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedEvents,
  fetchEvents,
  getCachedEvents,
  getLastFetchTime,
  hasEventChanges,
  type Event,
  type EventPost,
} from './events';

const post = (uuid: string, relevance: number, extra: Record<string, unknown> = {}): EventPost =>
  ({
    id: 1,
    uuid,
    content: `post ${uuid}`,
    source: 'fictional',
    uri: `https://example.test/${uuid}`,
    hash: uuid,
    author: 'a',
    createdAt: '2026-11-22T10:00:00.000Z',
    relevance,
    match_score: 1,
    ...extra,
  }) as EventPost;

const event = (uuid: string, createdAt: string, posts: EventPost[], extra: Record<string, unknown> = {}): Event =>
  ({
    id: 1,
    uuid,
    title: `Event ${uuid}`,
    summary: 'summary',
    status: 'open',
    created_at: createdAt,
    updated_at: createdAt,
    posts_count: posts?.length ?? 0,
    posts,
    ...extra,
  }) as Event;

function answer(events: Event[] | undefined, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(events === undefined ? {} : { events, total: events.length }),
  });
}

describe('fifthbell events', () => {
  beforeEach(() => {
    clearCachedEvents();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks the events API, with the normalised preferred language, and caches the answer with its fetch time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
    const fetchMock = answer([event('a', '2026-11-22T09:00:00.000Z', [post('p1', 1)])]);
    vi.stubGlobal('fetch', fetchMock);
    const events = await fetchEvents({ language: 'ES-mx' as never });
    expect(fetchMock).toHaveBeenCalledWith('https://api.monitor.gaulatti.com/events?language=es');
    expect(events.map((e) => e.uuid)).toEqual(['a']);
    expect(getCachedEvents()).toBe(events);
    expect(getLastFetchTime()?.toISOString()).toBe('2026-11-22T12:00:00.000Z');
  });

  it('asks without a language when the preferred one is missing, blank or unknown', async () => {
    const fetchMock = answer([]);
    vi.stubGlobal('fetch', fetchMock);
    await fetchEvents();
    await fetchEvents({ language: '   ' as never });
    await fetchEvents({ language: 'fr' as never });
    await fetchEvents({ language: 42 as never });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(new Array(4).fill('https://api.monitor.gaulatti.com/events'));
  });

  it('throws on a non-ok answer and keeps the cache as it was', async () => {
    vi.stubGlobal('fetch', answer(undefined, false, 503));
    await expect(fetchEvents()).rejects.toThrow('Failed to fetch events: 503');
    expect(getCachedEvents()).toBeNull();
    expect(getLastFetchTime()).toBeNull();
  });

  it('treats an answer without an events list as empty', async () => {
    vi.stubGlobal('fetch', answer(undefined));
    expect(await fetchEvents()).toEqual([]);
  });

  it('keeps only the events of the allowed languages: by their own language, lang or locale, else by a post, and keeps an event with no language', async () => {
    const events = [
      event('direct', '2026-11-22T01:00:00.000Z', [], { language: 'es' }),
      event('lang', '2026-11-22T02:00:00.000Z', [], { lang: 'IT' }),
      event('locale', '2026-11-22T03:00:00.000Z', [], { locale: 'en-US' }),
      event('by-post', '2026-11-22T04:00:00.000Z', [post('p1', 1), post('p2', 1, { language: 'es' })]),
      event('by-post-lang', '2026-11-22T05:00:00.000Z', [post('p3', 1, { lang: 'it' })]),
      event('by-post-locale', '2026-11-22T06:00:00.000Z', [post('p4', 1, { locale: 'en' })]),
      event('none', '2026-11-22T07:00:00.000Z', [post('p5', 1)]),
      event('no-posts', '2026-11-22T08:00:00.000Z', undefined as never),
      event('other', '2026-11-22T09:00:00.000Z', [], { language: 'de' }),
    ];
    vi.stubGlobal('fetch', answer(events));
    const kept = await fetchEvents({ allowedLanguages: ['es', 'ES', 'it-IT', 'xx', 7 as never] as never });
    expect(kept.map((e) => e.uuid)).toEqual(['direct', 'lang', 'by-post', 'by-post-lang', 'none', 'no-posts', 'other']);
    // 'other' is German, which is not allowed, but 'de' is unknown to the tokeniser, so it has no language and stays.
  });

  it('ignores a non-array allowed list and keeps every event', async () => {
    vi.stubGlobal('fetch', answer([event('a', '2026-11-22T01:00:00.000Z', [], { language: 'es' })]));
    const kept = await fetchEvents({ allowedLanguages: 'es' as never });
    expect(kept.map((e) => e.uuid)).toEqual(['a']);
  });

  it('merges a later fetch into the cached events: new events added, known events updated with their posts merged by relevance, all in creation order', async () => {
    const first = [
      event('old', '2026-11-22T05:00:00.000Z', [post('p1', 1), post('p2', 5)]),
      event('older', '2026-11-22T03:00:00.000Z', [post('p9', 1)]),
    ];
    vi.stubGlobal('fetch', answer(first));
    await fetchEvents();
    const second = [
      event('old', '2026-11-22T05:00:00.000Z', [post('p1', 9), post('p3', 3)], { title: 'Renamed', summary: 'new', status: 'closed', updated_at: '2026-11-22T11:00:00.000Z', posts_count: 3 }),
      event('fresh', '2026-11-22T04:00:00.000Z', [post('p4', 1)]),
    ];
    vi.stubGlobal('fetch', answer(second));
    const merged = await fetchEvents();
    expect(merged.map((e) => e.uuid)).toEqual(['older', 'fresh', 'old']);
    const old = merged.find((e) => e.uuid === 'old')!;
    expect(old).toMatchObject({ title: 'Renamed', summary: 'new', status: 'closed', updated_at: '2026-11-22T11:00:00.000Z', posts_count: 3 });
    expect(old.posts.map((p) => [p.uuid, p.relevance])).toEqual([['p1', 9], ['p2', 5], ['p3', 3]]);
    expect(getCachedEvents()).toBe(merged);
  });

  it('replaces an empty cache with the new events', async () => {
    vi.stubGlobal('fetch', answer([]));
    await fetchEvents();
    vi.stubGlobal('fetch', answer([event('a', '2026-11-22T01:00:00.000Z', [])]));
    expect((await fetchEvents()).map((e) => e.uuid)).toEqual(['a']);
  });

  it('keeps one cache per language and allowed-language set, and reads the one of the last fetch', async () => {
    vi.stubGlobal('fetch', answer([event('en-event', '2026-11-22T01:00:00.000Z', [])]));
    await fetchEvents({ language: 'en', allowedLanguages: ['it', 'es'] });
    vi.stubGlobal('fetch', answer([event('es-event', '2026-11-22T01:00:00.000Z', [])]));
    await fetchEvents({ language: 'es' });
    expect(getCachedEvents()?.map((e) => e.uuid)).toEqual(['es-event']);
    vi.stubGlobal('fetch', answer([event('en-event-2', '2026-11-22T02:00:00.000Z', [])]));
    const again = await fetchEvents({ language: 'en', allowedLanguages: ['es', 'it'] });
    // The same key as the first fetch (the allowed list is sorted): merged with it.
    expect(again.map((e) => e.uuid)).toEqual(['en-event', 'en-event-2']);
  });

  it('forgets everything on clear', async () => {
    vi.stubGlobal('fetch', answer([event('a', '2026-11-22T01:00:00.000Z', [])]));
    await fetchEvents();
    clearCachedEvents();
    expect(getCachedEvents()).toBeNull();
    expect(getLastFetchTime()).toBeNull();
  });

  describe('hasEventChanges', () => {
    const base = () => [event('a', '2026-11-22T01:00:00.000Z', [post('p1', 1)]), event('b', '2026-11-22T02:00:00.000Z', [post('p2', 1)])];

    it('is false for the same events', () => {
      expect(hasEventChanges(base(), base())).toBe(false);
      expect(hasEventChanges([], [])).toBe(false);
    });

    it('is true when the count differs', () => {
      expect(hasEventChanges(base(), base().slice(0, 1))).toBe(true);
    });

    it('is true when an event appeared or disappeared with the same count', () => {
      const swapped = [base()[0], event('c', '2026-11-22T03:00:00.000Z', [post('p2', 1)])];
      expect(hasEventChanges(base(), swapped)).toBe(true);
      expect(hasEventChanges(swapped, base())).toBe(true);
    });

    it('is true when an old event is missing from a new list that repeats another event', () => {
      const [a] = base();
      expect(hasEventChanges(base(), [a, a])).toBe(true);
    });

    it('is true when the title, status, posts count or posts length changed', () => {
      const changed = (patch: Record<string, unknown>) => {
        const next = base();
        next[0] = { ...next[0], ...patch } as Event;
        return next;
      };
      expect(hasEventChanges(base(), changed({ title: 'x' }))).toBe(true);
      expect(hasEventChanges(base(), changed({ status: 'closed' }))).toBe(true);
      expect(hasEventChanges(base(), changed({ posts_count: 9 }))).toBe(true);
      expect(hasEventChanges(base(), changed({ posts: [post('p1', 1), post('p8', 1)] }))).toBe(true);
    });

    it('is true when a post was replaced by another with the same number of posts', () => {
      const next = base();
      next[0] = { ...next[0], posts: [post('p7', 1)] } as Event;
      expect(hasEventChanges(base(), next)).toBe(true);
    });
  });
});
