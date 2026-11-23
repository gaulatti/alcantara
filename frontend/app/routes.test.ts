import { afterEach, describe, expect, it, vi } from 'vitest';

// gaulatti/alcantara#352: the component bench and the fixtures are development and test
// routes. A production build's route table must not register them.
const benchAndFixtures = [
  'preview',
  'layout-demo',
  'console-fixture',
  'media-fixture',
  'labels-fixture',
  'song-intro-fixture',
  'similarity-fixture',
  'slideshow-fixture',
  'recording-fixture',
  'filler-fixture',
  'access-fixture',
];

type RouteNode = { path?: string; children?: RouteNode[] };

function pathsOf(nodes: RouteNode[]): string[] {
  return nodes.flatMap((node) => [...(node.path ? [node.path] : []), ...pathsOf(node.children ?? [])]);
}

async function loadRouteTable(): Promise<string[]> {
  vi.resetModules();
  const table = (await import('./routes')).default as RouteNode[];
  return pathsOf(table);
}

describe('route table', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the bench and fixtures in development and tests', async () => {
    const paths = await loadRouteTable();
    for (const path of benchAndFixtures) expect(paths).toContain(path);
  });

  it('a production build registers none of the bench or fixture paths, and keeps the operator screens', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_AUTH_MODE', '');
    const paths = await loadRouteTable();
    for (const path of benchAndFixtures) expect(paths).not.toContain(path);
    for (const path of ['instants', 'songs', 'media', 'access', 'flight']) expect(paths).toContain(path);
  });
});
