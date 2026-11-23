import { describe, expect, it, vi } from 'vitest';
import { buildChartFeedLookup, CHART_FEED_URL, chartEntryKey, loadChartLookup, matchChartEntry, realtimeChartValues, type ChartFeedLookup } from './chartFeed';
import { chartLookupId, resolveChartDisplay } from './programChartValues';

// One refresh as the backend lists it: its match key, chart id, rank and spins.
const ENTRIES = [
  { key: 'alba cuore', id: '501', artist: 'Alba', title: 'Cuore', rank: '1', spins: '310' },
  { key: 'zed and amy tres bien and co', id: '99', artist: 'Zed & Amy', title: 'Très Bien & Co', rank: '2', spins: '40' },
  { key: 'dario solo', id: null, artist: 'Dario', title: 'Solo', rank: null, spins: null }
];

// The generic feed the backend serves for that same refresh.
const FEED = ENTRIES.map((entry) => ({
  provider: entry.id ? 'chart-a' : 'chart-b',
  externalId: entry.id,
  title: entry.title,
  artist: entry.artist,
  rank: entry.rank,
  spins: entry.spins,
  updatedAt: '2026-11-17T09:00:00.000Z'
}));

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
function display(lookup: ChartFeedLookup | null, item: (typeof CHYRONS)[number]) {
  const realtime = realtimeChartValues(lookup, { id: chartLookupId(item.legacyId, item), text: item.text || null });
  return resolveChartDisplay({ scene: {}, song: item, realtime, legacy: {} });
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('program page chart feed', () => {
  it('builds the same match keys as the backend', () => {
    for (const entry of ENTRIES) {
      expect(chartEntryKey(entry.artist, entry.title)).toBe(entry.key);
    }
  });

  it('renders rank and spins from the feed, by chart id or chyron text, and requests nothing but the feed', async () => {
    const fetchImpl = vi.fn(async () => response(FEED));

    const lookup = await loadChartLookup(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl.mock.calls).toEqual([[CHART_FEED_URL]]);
    expect(CHYRONS.map((item) => display(lookup, item))).toEqual([
      { rank: '1', spins: '310' },
      { rank: '2', spins: '40' },
      { rank: '1', spins: '310' },
      { rank: '2', spins: '40' },
      { rank: undefined, spins: undefined },
      { rank: undefined, spins: undefined }
    ]);
    expect(lookup.updatedAt).toBe('2026-11-17T09:00:00.000Z');
  });

  it('reports a feed that is unavailable, failing or not a list, and calls nothing else', async () => {
    const unavailable: Array<[() => Promise<Response>, string]> = [
      [() => Promise.resolve(response({}, false, 404)), 'HTTP 404'],
      [() => Promise.reject(new TypeError('Failed to fetch')), 'Failed to fetch'],
      [() => Promise.resolve(response({ entries: [] })), 'The chart feed did not return a list']
    ];
    for (const [feed, message] of unavailable) {
      const fetchImpl = vi.fn(feed);
      await expect(loadChartLookup(fetchImpl as unknown as typeof fetch)).rejects.toThrow(message);
      expect(fetchImpl.mock.calls).toEqual([[CHART_FEED_URL]]);
    }
  });

  it('shows nothing before a lookup has loaded', () => {
    expect(realtimeChartValues(null, { id: '501' })).toBeNull();
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
