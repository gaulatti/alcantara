jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import type { McpTier } from './contract';
import { McpRegistry } from './mcp-registry.service';

/**
 * gaulatti/alcantara#221: every MCP tool or capability the application
 * registers is one of appendix A's rows or one of #214's radio tools, with
 * exactly that row's permission and tier, and nothing that returns a credential is ever registered. This is a
 * subset check: equality with all of appendix A is the tracker's closer
 * (gaulatti/alcantara#210), green once every capability ticket has landed.
 *
 * The real AppModule is compiled (every provider constructed, no lifecycle
 * hook run, nothing connects), then the registry collects its specs exactly as
 * it does at startup.
 */

type Row = { permission: string; tier: McpTier };

const BUILT_INS: Record<string, Row> = {
  whoami: { permission: ALCANTARA_PERMISSIONS.access, tier: 'R' },
  list_programs: { permission: ALCANTARA_PERMISSIONS.program.read, tier: 'R' },
  list_capabilities: { permission: ALCANTARA_PERMISSIONS.access, tier: 'R' },
  call_capability: { permission: ALCANTARA_PERMISSIONS.access, tier: 'R' },
};

/**
 * The first-class daily radio tools of gaulatti/alcantara#214, pinned from
 * that ticket's table: they are tools of their own, not appendix A rows.
 * Only its read tools were built; its write and action tools were dropped in
 * favour of the appendix A capabilities that do the same (one way to do each
 * thing), so none is expected here.
 */
const RADIO_TOOLS: Record<string, [string, McpTier]> = {
  get_on_air: ['radio.read', 'R'],
  get_queue: ['radio.read', 'R'],
  get_rundown: ['flight.read', 'R'],
  wait_for_change: ['radio.read', 'R'],
  get_as_run: ['radio.read', 'R'],
  get_royalty_summary: ['radio.read', 'R'],
  search_songs: ['song.read', 'R'],
  get_song: ['song.read', 'R'],
  get_instants: ['instant.read', 'R'],
  get_radio_health: ['radio.read', 'R'],
};

/**
 * Capabilities that gaulatti/alcantara#218 names beside appendix A's rows:
 * the audio upload of the console with the file fetched from an address,
 * which has no route of its own to list.
 */
const EXTRA_CAPABILITIES: Record<string, [string, McpTier]> = {
  import_media_from_url: ['upload.create', 'W'],
};

function permissionKey(short: string): string {
  if (short === 'access') return ALCANTARA_PERMISSIONS.access;
  const [area, action] = short.split('.');
  const group = (
    ALCANTARA_PERMISSIONS as unknown as Record<string, Record<string, string>>
  )[area];
  const key = group?.[action];
  if (!key) throw new Error(`appendix A names an unknown permission ${short}`);
  return key;
}

function appendix(): {
  rows: Map<string, Row>;
  excluded: number;
  covered: Map<string, string>;
} {
  const lines = readFileSync(join(__dirname, 'appendix-a.tsv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);
  const rows = new Map<string, Row>();
  const covered = new Map<string, string>();
  let excluded = 0;
  for (const line of lines) {
    const [, , , permission, , capability, tier] = line.split('\t');
    if (tier.startsWith('excluded')) {
      excluded += 1;
      continue;
    }
    // A row another registered tool already does is marked "covered by <tool>".
    const coveredBy = /^covered by ([a-z_]+)$/.exec(tier);
    if (coveredBy) {
      covered.set(capability, coveredBy[1]);
      continue;
    }
    if (rows.has(capability)) throw new Error(`duplicate row ${capability}`);
    rows.set(capability, {
      permission: permissionKey(permission),
      tier: tier as McpTier,
    });
  }
  return { rows, excluded, covered };
}

describe('MCP registry against appendix A', () => {
  let registered: { name: string; permission: string; tier: McpTier }[];

  const previousUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    // Providers are constructed only; nothing connects to this address.
    process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:1/fixture';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const registry = moduleRef.get(McpRegistry);
    registry.onModuleInit();
    registered = registry.all().map((spec) => ({
      name: spec.name,
      permission: spec.permission,
      tier: spec.tier,
    }));
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  // The three bracket rows keep their capability names; their path and
  // handler columns are written neutrally, so this file carries no brand
  // literal (the brand-literal ratchet). Only name, permission and tier are read.
  it('reads all of appendix A: capabilities, covered rows and the 8 exclusions', () => {
    const { rows, excluded, covered } = appendix();
    expect(rows.size + covered.size).toBe(170);
    expect(excluded).toBe(8);
    // auth_get_me is whoami (same permission, same tier, the caller's own
    // identity), as is access_my_permissions (the caller's own keys); the
    // five uploads are import_media_from_url's kinds.
    expect(Object.fromEntries(covered)).toEqual({
      access_my_permissions: 'whoami',
      auth_get_me: 'whoami',
      upload_artwork: 'import_media_from_url',
      upload_background: 'import_media_from_url',
      upload_instant: 'import_media_from_url',
      upload_song: 'import_media_from_url',
      upload_stinger: 'import_media_from_url',
    });
    expect(rows.get('as-run_export')).toEqual({
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
    });
  });

  // A "covered by" value must name a tool or capability that is actually
  // registered (a #214 tool, a built-in or a pinned extra capability), so the
  // column cannot point at something that does not exist.
  it('names only registered tools in the covered-by column', () => {
    const { covered } = appendix();
    const names = new Set(registered.map((spec) => spec.name));
    for (const [row, tool] of covered) {
      expect({ row, tool, registered: names.has(tool) }).toEqual({
        row,
        tool,
        registered: true,
      });
    }
  });

  // gaulatti/alcantara#210's closing check: every appendix A capability
  // (minus exclusions and covered rows), every #214 radio tool and the
  // built-ins are registered, and nothing else.
  it('registers exactly appendix A, the #214 radio tools, the extra capabilities and the built-ins', () => {
    const { rows } = appendix();
    const expected = [
      ...rows.keys(),
      ...Object.keys(RADIO_TOOLS),
      ...Object.keys(EXTRA_CAPABILITIES),
      ...Object.keys(BUILT_INS),
    ].sort();
    expect(registered.map((spec) => spec.name).sort()).toEqual(expected);
  });

  it('registers the four built-ins, read tier, with their permissions', () => {
    for (const [name, row] of Object.entries(BUILT_INS)) {
      expect(registered).toContainEqual({ name, ...row });
    }
  });

  it('registers only appendix A rows, the #214 radio tools and the extra capabilities, each with its exact permission and tier', () => {
    const { rows } = appendix();
    for (const [name, [permission, tier]] of Object.entries({
      ...RADIO_TOOLS,
      ...EXTRA_CAPABILITIES,
    })) {
      expect(rows.has(name)).toBe(false);
      rows.set(name, { permission: permissionKey(permission), tier });
    }
    for (const spec of registered) {
      if (BUILT_INS[spec.name]) continue;
      expect({ name: spec.name, row: rows.get(spec.name) }).toEqual({
        name: spec.name,
        row: { permission: spec.permission, tier: spec.tier },
      });
    }
    expect(new Set(registered.map((spec) => spec.name)).size).toBe(
      registered.length,
    );
  });

  it('never registers a capability that hands out a ticket or a credential', () => {
    for (const spec of registered) {
      expect(spec.name).not.toMatch(/ticket|credential/);
    }
  });
});
