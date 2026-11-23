// The application is built without running it (Nest's preview mode creates no
// provider, so no database or secret is needed); the audio parser it imports
// is ESM-only and is never called.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, NestFactory } from '@nestjs/core';
import { PathsExplorer } from '@nestjs/core/router/paths-explorer';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import {
  BACKEND,
  generateRouteInventory,
} from '../../scripts/generate-route-inventory';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';

// gaulatti/alcantara#156: every HTTP route the application registers, written
// down, so that a route renamed, removed, added, made public or given another
// permission fails this test until the inventory is regenerated on purpose
// (`npx ts-node scripts/generate-route-inventory.ts`).
//
// The application is built the way main.ts builds it (AppModule on the Fastify
// adapter) and the routes are read twice: from the HTTP server's own route
// table, and from each controller's handlers, where `public` and `permission`
// are read the way the authorization guard reads them (the handler's value,
// else its controller's). The two readings must agree before either is
// compared with the inventory.

interface RouteEntry {
  method: string;
  path: string;
  public: boolean;
  permission: string | null;
}

const INVENTORY = join(__dirname, 'route-inventory.json');

const byPathThenMethod = (a: RouteEntry, b: RouteEntry) =>
  a.path.localeCompare(b.path) || a.method.localeCompare(b.method);

function joinPath(prefix: string, path: string): string {
  const combined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return combined.length > 1 ? combined.replace(/\/$/, '') : combined;
}

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value ?? '/']).map((part) => String(part));

function handlerRoutes(app: INestApplication): RouteEntry[] {
  const explorer = new PathsExplorer(new MetadataScanner());
  const routes: RouteEntry[] = [];
  for (const module of app.get(ModulesContainer).values())
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as
        | (new (...args: never[]) => object)
        | null;
      if (!controller) continue;
      const controllerPublic = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        controller,
      ) as boolean | undefined;
      const controllerPermission = Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        controller,
      ) as string | undefined;
      for (const definition of explorer.scanForPaths(
        Object.create(controller.prototype as object) as object,
        controller.prototype as object,
      )) {
        const handler = definition.targetCallback;
        const isPublic =
          (Reflect.getMetadata(IS_PUBLIC_KEY, handler) as
            | boolean
            | undefined) ??
          controllerPublic ??
          false;
        const permission =
          (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler) as
            | string
            | undefined) ??
          controllerPermission ??
          null;
        for (const prefix of asList(
          Reflect.getMetadata(PATH_METADATA, controller),
        ))
          for (const path of definition.path)
            routes.push({
              method: RequestMethod[definition.requestMethod],
              path: joinPath(prefix, path),
              public: isPublic === true,
              permission,
            });
      }
    }
  return routes.sort(byPathThenMethod);
}

async function readApplication(): Promise<{
  handlers: RouteEntry[];
  server: string[];
}> {
  const adapter = new FastifyAdapter();
  const server: string[] = [];
  // Fastify adds a HEAD twin to every GET on its own; no handler declares one.
  const routeTable = adapter.getInstance();
  routeTable.addHook('onRoute', (route) => {
    for (const method of [route.method].flat())
      if (method !== 'HEAD') server.push(`${method} ${route.url}`);
  });
  const app = await NestFactory.create(AppModule, adapter, {
    preview: true,
    logger: false,
  });
  try {
    await app.init();
    return { handlers: handlerRoutes(app), server: server.sort() };
  } finally {
    await app.close();
  }
}

const key = (route: RouteEntry) => `${route.method} ${route.path}`;

export function differences(
  registered: RouteEntry[],
  inventory: RouteEntry[],
): string[] {
  const listed = new Map(inventory.map((route) => [key(route), route]));
  const live = new Map(registered.map((route) => [key(route), route]));
  const problems: string[] = [];
  for (const [name, route] of live) {
    const entry = listed.get(name);
    if (!entry) {
      problems.push(`${name}: registered but not in the inventory`);
      continue;
    }
    if (entry.public !== route.public)
      problems.push(
        `${name}: public is ${String(route.public)} in the application, ${String(entry.public)} in the inventory`,
      );
    if (entry.permission !== route.permission)
      problems.push(
        `${name}: permission is ${String(route.permission)} in the application, ${String(entry.permission)} in the inventory`,
      );
  }
  for (const name of listed.keys())
    if (!live.has(name))
      problems.push(`${name}: in the inventory but not registered`);
  return problems;
}

describe('HTTP route inventory (#156)', () => {
  let registered: RouteEntry[];
  let server: string[];

  beforeAll(async () => {
    ({ handlers: registered, server } = await readApplication());
  }, 60_000);

  it('reads the same routes from the HTTP server and from the handlers', () => {
    expect(registered.length).toBeGreaterThan(0);
    expect([...new Set(registered.map(key))].sort()).toEqual(server);
  });

  if (process.env.ROUTE_INVENTORY_WRITE === '1') {
    it('writes the inventory from the application', () => {
      writeFileSync(INVENTORY, `${JSON.stringify(registered, null, 2)}\n`);
    });
    return;
  }

  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8')) as RouteEntry[];

  it('matches every registered route, its public flag and its permission', () => {
    const problems = differences(registered, inventory);
    if (problems.length)
      throw new Error(
        `The HTTP surface differs from src/api-surface/route-inventory.json (regenerate it with npx ts-node scripts/generate-route-inventory.ts if the change is intended):\n${problems.join('\n')}`,
      );
  });

  it('keeps the inventory sorted by path then method, with no duplicate', () => {
    expect(inventory.map(key)).toEqual(
      [...inventory].sort(byPathThenMethod).map(key),
    );
    expect(new Set(inventory.map(key)).size).toBe(inventory.length);
  });

  it('names a route whose path, public flag or permission drifted', () => {
    const [first, second] = inventory;
    const renamed = [
      { ...first, path: `${first.path}-renamed` },
      ...inventory.slice(1),
    ];
    expect(differences(renamed, inventory)).toEqual([
      `${first.method} ${first.path}-renamed: registered but not in the inventory`,
      `${first.method} ${first.path}: in the inventory but not registered`,
    ]);
    const flipped = inventory.map((route) =>
      route === second ? { ...route, public: !route.public } : route,
    );
    expect(differences(flipped, inventory)).toEqual([
      `${second.method} ${second.path}: public is ${String(!second.public)} in the application, ${String(second.public)} in the inventory`,
    ]);
  });
});

describe('route inventory generator (#156)', () => {
  it('runs this spec in write mode from the backend directory and answers its exit status', () => {
    const run = jest.fn(() => ({ status: 0 }));
    expect(generateRouteInventory(run, { PATH: '/bin' })).toBe(0);
    expect(run).toHaveBeenCalledWith(
      'npx',
      ['jest', 'src/api-surface/route-inventory.spec.ts'],
      {
        cwd: BACKEND,
        stdio: 'inherit',
        env: { PATH: '/bin', ROUTE_INVENTORY_WRITE: '1' },
      },
    );
    expect(join(BACKEND, 'src')).toBe(join(__dirname, '..'));
  });

  it('fails when the spec fails or does not exit', () => {
    expect(generateRouteInventory(() => ({ status: 1 }), {})).toBe(1);
    expect(generateRouteInventory(() => ({ status: null }), {})).toBe(1);
  });
});
