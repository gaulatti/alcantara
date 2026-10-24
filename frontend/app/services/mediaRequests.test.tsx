import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene, deleteScene, fetchLayouts, fetchScenes, persistSceneAttributes, updateScene } from './scenes';
import { fetchSongCatalog, fetchSongsPage } from './songs';
import { fetchInstants, stopAllInstants, triggerInstant } from './instants';

vi.mock('../utils/apiBaseUrl', () => ({ apiUrl: (path: string) => `https://api.example${path}` }));
afterEach(() => vi.unstubAllGlobals());

describe('scene library requests', () => {
  const scene = { id: 7, name: 'Opening', layoutId: 2, metadata: '{}', chyronText: null };
  const createPayload = { name: 'Opening', layoutId: 2, metadata: {} };
  const cases = [
    { name: 'list scenes', run: () => fetchScenes(), path: '/scenes', init: undefined, response: [scene] },
    { name: 'list layouts', run: () => fetchLayouts(), path: '/layouts', init: undefined, response: [{ id: 2, name: 'Lower third' }] },
    { name: 'create scene', run: () => createScene(createPayload), path: '/scenes', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createPayload) }, response: scene },
    { name: 'update scene', run: () => updateScene(7, { name: 'Updated' }), path: '/scenes/7', init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Updated' }) }, response: { ...scene, name: 'Updated' } },
    { name: 'persist attributes', run: () => persistSceneAttributes(7, {}), path: '/scenes/7', init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: {} }) }, response: scene },
    { name: 'delete scene', run: () => deleteScene(7), path: '/scenes/7', init: { method: 'DELETE' }, response: undefined },
  ];
  it.each(cases)('$name uses the expected endpoint and producer result', async ({ run, path, init, response }) => {
    const request = vi.fn(async () => new Response(response === undefined ? null : JSON.stringify(response)));
    vi.stubGlobal('fetch', request);
    await expect(run()).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith(`https://api.example${path}`, ...(init === undefined ? [] : [init]));
  });
  it.each(cases)('$name rejects a backend error', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(run()).rejects.toThrow('HTTP 403');
  });
});

describe('song catalog requests', () => {
  it('loads every catalog entry from the unbounded catalog endpoint', async () => {
    const song = { id: 1, artist: 'Artist', title: 'Song' };
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [song], meta: { total: 1 } })));
    vi.stubGlobal('fetch', request);
    await expect(fetchSongCatalog()).resolves.toEqual([song]);
    expect(request).toHaveBeenCalledWith('https://api.example/songs?limit=0');
  });
  it('preserves explicit filters, sorting, pagination, and the target program', async () => {
    const payload = { data: [], meta: { total: 0, page: 2 } };
    const request = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal('fetch', request);
    await expect(fetchSongsPage({ search: 'song & artist', enabled: false, sortBy: 'title', sortOrder: 'desc', page: 2, limit: 25, programId: 'show/a' })).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith('https://api.example/songs?search=song+%26+artist&enabled=false&sortBy=title&sortOrder=desc&page=2&limit=25&programId=show%2Fa');
    await fetchSongsPage();
    expect(request).toHaveBeenLastCalledWith('https://api.example/songs');
  });
  it('reports catalog and page failures instead of returning an empty library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('failure', { status: 503 })));
    await expect(fetchSongCatalog()).rejects.toThrow('HTTP 503');
    await expect(fetchSongsPage()).rejects.toThrow('HTTP 503');
  });
});

describe('instant playback requests', () => {
  it('fetches global or program-scoped instant catalogs', async () => {
    const instants = [{ id: 8, name: 'Bumper' }];
    const request = vi.fn(async () => new Response(JSON.stringify(instants)));
    vi.stubGlobal('fetch', request);
    await expect(fetchInstants()).resolves.toEqual(instants);
    expect(request).toHaveBeenLastCalledWith('https://api.example/instants');
    await fetchInstants('show/a');
    expect(request).toHaveBeenLastCalledWith('https://api.example/instants?programId=show%2Fa');
  });
  it('sends play and stop mutations to the intended program only', async () => {
    const request = vi.fn(async () => new Response(null));
    vi.stubGlobal('fetch', request);
    await expect(triggerInstant(8, 'show/a')).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith('https://api.example/instants/8/play?programId=show%2Fa', { method: 'POST' });
    await expect(stopAllInstants('show/a')).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith('https://api.example/instants/stop-all?programId=show%2Fa', { method: 'POST' });
  });
  it('rejects failed catalog, play, and stop operations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(fetchInstants()).rejects.toThrow('HTTP 403');
    await expect(triggerInstant(8, 'main')).rejects.toThrow('HTTP 403');
    await expect(stopAllInstants('main')).rejects.toThrow('HTTP 403');
  });
});
