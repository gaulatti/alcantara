import { describe, expect, it, vi } from 'vitest';
import { buildChartFeedLookup, CHART_FEED_URL, chartEntryKey, loadChartLookup, matchChartEntry, realtimeChartValues, type ChartSource } from './chartFeed';
import { chartLookupId, resolveChartDisplay } from './programChartValues';

// One refresh as the backend's proxy lists it today: its match key, chart id, rank and spins.
const PROXY_ENTRIES = [
  { key: 'alba cuore', id: '501', artist: 'Alba', title: 'Cuore', rank: '1', spins: '310' },
  { key: 'zed and amy tres bien and co', id: '99', artist: 'Zed & Amy', title: 'Très Bien & Co', rank: '2', spins: '40' },
  { key: 'dario solo', id: null, artist: 'Dario', title: 'Solo', rank: null, spins: null }
];

// The generic feed the backend serves for that same refresh.
const FEED = PROXY_ENTRIES.map((entry) => ({
  provider: entry.id ? 'chart-a' : 'chart-b',
  externalId: entry.id,
  title: entry.title,
  artist: entry.artist,
  rank: entry.rank,
  spins: entry.spins,
  updatedAt: '2026-11-17T09:00:00.000Z'
}));

// Today's proxy lookup: entries by chart id and by the key the backend computed.
const PROXY_LOOKUP = {
  byId: Object.fromEntries(PROXY_ENTRIES.filter((e) => e.id).map((e) => [e.id as string, e])),
  byKey: Object.fromEntries(PROXY_ENTRIES.map((e) => [e.key, e]))
};

// The active chyron items the page's chart component matches.
const CHYRONS: Array<{ legacyId: string | null; externalChartId?: string; text: string }> = [
  { legacyId: '501', text: 'Something else' },
  { legacyId: null, text: 'Zed & Amy - Tres bien and co' },
  { legacyId: null, text: 'ALBA — Cuore' },
  { legacyId: null, externalChartId: '99', text: '' },
  { legacyId: null, text: 'Dario Solo' },
  { legacyId: null, text: 'Nobody Nowhere' }
];

// The page's chart expression for one chyron item (program.tsx, the chart component case).
function display(chart: ChartSource<typeof PROXY_LOOKUP> | null, item: (typeof CHYRONS)[number]) {
  const realtime = realtimeChartValues(chart, { id: chartLookupId(item.legacyId, item), text: item.text || null }, (lookup, match) => {
    const entry = matchChartEntry(lookup, match);
    return entry ? { rank: entry.rank, spins: entry.spins } : null;
  });
  return resolveChartDisplay({ scene: {}, song: item, realtime, legacy: {} });
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('program page chart feed', () => {
  it('builds the same match keys as the backend', () => {
    for (const entry of PROXY_ENTRIES) {
      expect(chartEntryKey(entry.artist, entry.title)).toBe(entry.key);
    }
  });

  it('renders the same rank and spins from the feed as from the proxy, and requests nothing but the feed', async () => {
    const fetchImpl = vi.fn(async () => response(FEED));
    const fallback = vi.fn(async () => PROXY_LOOKUP);

    const chart = await loadChartLookup(fallback, fetchImpl as unknown as typeof fetch);

    expect(chart.source).toBe('feed');
    expect(fetchImpl.mock.calls).toEqual([[CHART_FEED_URL]]);
    expect(fallback).not.toHaveBeenCalled();
    const fromProxy = CHYRONS.map((item) => display({ source: 'fallback', lookup: PROXY_LOOKUP }, item));
    expect(CHYRONS.map((item) => display(chart, item))).toEqual(fromProxy);
    expect(fromProxy).toEqual([
      { rank: '1', spins: '310' },
      { rank: '2', spins: '40' },
      { rank: '1', spins: '310' },
      { rank: '2', spins: '40' },
      { rank: undefined, spins: undefined },
      { rank: undefined, spins: undefined }
    ]);
    expect(chart.source === 'feed' && chart.lookup.updatedAt).toBe('2026-11-17T09:00:00.000Z');
  });

  it('falls back to the proxy as today when the feed is unavailable', async () => {
    const unavailable = [
      () => Promise.resolve(response({}, false, 404)),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(response({ entries: [] }))
    ];
    for (const feed of unavailable) {
      const fetchImpl = vi.fn(feed);
      const fallback = vi.fn(async () => PROXY_LOOKUP);

      const chart = await loadChartLookup(fallback, fetchImpl as unknown as typeof fetch);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(chart).toEqual({ source: 'fallback', lookup: PROXY_LOOKUP });
      expect(CHYRONS.map((item) => display(chart, item))[0]).toEqual({ rank: '1', spins: '310' });
    }
  });

  it('reports a fallback failure as the page did before', async () => {
    const fetchImpl = vi.fn(async () => response({}, false, 503));
    await expect(
      loadChartLookup(async () => {
        throw new Error('HTTP 502');
      }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('HTTP 502');
  });

  it('shows nothing before a lookup has loaded', () => {
    expect(realtimeChartValues(null, { id: '501' }, () => ({ rank: '9' }))).toBeNull();
    expect(matchChartEntry(null, { id: '501' })).toBeNull();
  });

  it('skips malformed feed entries and keeps the first entry for a shared key', () => {
    const lookup = buildChartFeedLookup([
      null,
      { artist: 'Only' },
      { artist: '??', title: '!!' },
      { artist: 'A', title: 'B', externalId: '', rank: 3 },
      { artist: 'a', title: 'b', externalId: '7', rank: '5' }
    ]);
    expect(lookup?.byKey['a b']).toMatchObject({ externalId: null, rank: null, spins: null, provider: '', updatedAt: '' });
    expect(lookup?.byId['7']).toMatchObject({ rank: '5' });
    expect(lookup?.updatedAt).toBeNull();
    expect(buildChartFeedLookup({})).toBeNull();
  });
});
