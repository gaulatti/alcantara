import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteRendererKeyAnswer, pageRendererKey } from './rendererKey';

// A fictional key, built here.
const KEY = 'alrk_fictional-page-key';

describe('the page renderer key', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    delete document.documentElement.dataset.rendererKey;
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('reads #key=, keeps it for the session, and has none without either', () => {
    expect(pageRendererKey()).toBe('');
    window.history.replaceState(null, '', `/program/p#key=${KEY}`);
    expect(pageRendererKey()).toBe(KEY);
    window.history.replaceState(null, '', '/program/p');
    expect(pageRendererKey()).toBe(KEY);
  });

  it('says once, off the picture, that a refused key needs the page reopened, and nothing for other answers', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('renderer-key-refused', listener);
    for (const status of [200, 404, 500]) noteRendererKeyAnswer(status);
    expect(document.documentElement.dataset.rendererKey).toBeUndefined();
    noteRendererKeyAnswer(401);
    noteRendererKeyAnswer(401);
    expect(document.documentElement.dataset.rendererKey).toBe('changed');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('renderer key changed, reload');
    noteRendererKeyAnswer(403);
    expect(document.documentElement.dataset.rendererKey).toBe('other-program');
    expect(error.mock.calls[1][0]).toContain('another program');
    expect(events).toEqual(['changed', 'other-program']);
    window.removeEventListener('renderer-key-refused', listener);
  });
});
