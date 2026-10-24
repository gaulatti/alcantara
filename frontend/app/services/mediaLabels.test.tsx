import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllMediaLabels } from './mediaLabels';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./api', () => ({ authFetch: request }));
afterEach(() => vi.resetAllMocks());

describe('complete media label catalog', () => {
  it('reads every page, keeps the last version of an ID, and sorts by label', async () => {
    request
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'b', name: 'Zulu' }, { id: 'a', name: 'Alpha' }], meta: { totalPages: 2 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'b', name: 'Bravo' }, { id: 'c', name: 'Charlie' }], meta: { totalPages: 2 },
      })));
    await expect(fetchAllMediaLabels()).resolves.toEqual([
      { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }, { id: 'c', name: 'Charlie' },
    ]);
    expect(request.mock.calls).toEqual([
      ['/media-labels?page=1&limit=200'], ['/media-labels?page=2&limit=200'],
    ]);
  });

  it('accepts an explicitly empty catalog without requesting a second page', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { totalPages: 0 } })));
    await expect(fetchAllMediaLabels()).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a failed later page rather than returning a partial catalog', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'a', name: 'Alpha' }], meta: { totalPages: 2 },
    }))).mockResolvedValueOnce(new Response('failure', { status: 503 }));
    await expect(fetchAllMediaLabels()).rejects.toThrow('Failed to load labels: HTTP 503');
  });

  it.each([
    {}, { data: null, meta: { totalPages: 1 } }, { data: [] },
    { data: [], meta: {} }, { data: [], meta: { totalPages: -1 } },
    { data: [], meta: { totalPages: 1.5 } }, { data: [], meta: { totalPages: '2' } },
  ])('refuses malformed catalog metadata %j', async (payload) => {
    request.mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(fetchAllMediaLabels()).rejects.toThrow('Invalid media labels response');
  });

  it('preserves malformed JSON and network failures as failures', async () => {
    request.mockResolvedValueOnce(new Response('not JSON'));
    await expect(fetchAllMediaLabels()).rejects.toBeInstanceOf(SyntaxError);
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchAllMediaLabels()).rejects.toThrow('offline');
  });
});
