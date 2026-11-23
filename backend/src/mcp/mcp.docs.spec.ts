jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { McpRegistry } from './mcp-registry.service';

/**
 * gaulatti/alcantara#220: the client documentation cannot drift from the
 * registry. `docs/mcp.md` names every first-class tool in its Tools table,
 * `docs/mcp-capabilities.md` names every other registered capability as the
 * first cell of a table row, and every metric `docs/mcp.md` lists exists in
 * the backend source. The real AppModule is compiled exactly as in
 * `mcp.registry.appendix.spec.ts`.
 */

const REPO = join(__dirname, '..', '..', '..');

/** Names in backticks in the first cell of every table row of a section. */
function firstCellNames(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    const cell = /^\|([^|]*)\|/.exec(line);
    if (!cell) continue;
    for (const token of cell[1].matchAll(/`([^`]+)`/g)) {
      for (const part of token[1].split(',')) {
        // Family references such as `destination_*` are not names.
        if (/^[a-z][a-z0-9_-]*$/.test(part.trim())) names.push(part.trim());
      }
    }
  }
  return names;
}

/** The text of the section whose heading line is exactly `heading`. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const found = /^(#+) /.exec(lines[i]);
    if (found && found[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** Backticked names that start a list item. */
function listItemCodeNames(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    const item = /^- `([a-z][a-z0-9_]*)[`{]/.exec(line);
    if (item) names.push(item[1]);
  }
  return names;
}

function diff(
  file: string,
  what: string,
  documented: string[],
  registered: string[],
): string[] {
  const doc = new Set(documented);
  const reg = new Set(registered);
  const problems: string[] = [];
  for (const name of doc) {
    if (!reg.has(name)) {
      problems.push(`${file} names ${what} \`${name}\` that is not registered`);
    }
  }
  for (const name of reg) {
    if (!doc.has(name)) {
      problems.push(`${file} omits registered ${what} \`${name}\``);
    }
  }
  return problems.sort();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/** Documented names that are appendix A rows served by another tool. */
function appendixNotRegistered(): Set<string> {
  const names = new Set<string>();
  const lines = readFileSync(join(__dirname, 'appendix-a.tsv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);
  for (const line of lines) {
    const [, , , , , capability, tier] = line.split('\t');
    if (tier.startsWith('covered by') || tier.startsWith('excluded')) {
      names.add(capability);
    }
  }
  return names;
}

describe('MCP documentation against the registry', () => {
  let tools: string[];
  let capabilities: string[];
  const mcpDoc = readFileSync(join(REPO, 'docs', 'mcp.md'), 'utf8');
  const capabilitiesDoc = readFileSync(
    join(REPO, 'docs', 'mcp-capabilities.md'),
    'utf8',
  );
  const previousUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:1/fixture';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const registry = moduleRef.get(McpRegistry);
    registry.onModuleInit();
    const all = registry.all();
    tools = all.filter((spec) => spec.firstClass).map((spec) => spec.name);
    capabilities = all
      .filter((spec) => !spec.firstClass)
      .map((spec) => spec.name);
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  it('lists exactly the registered first-class tools in docs/mcp.md', () => {
    const documented = firstCellNames(section(mcpDoc, '## Tools'));
    expect(diff('docs/mcp.md', 'tool', documented, tools)).toEqual([]);
  });

  it('lists exactly the registered capabilities in docs/mcp-capabilities.md', () => {
    const documented = firstCellNames(capabilitiesDoc);
    const served = appendixNotRegistered();
    const problems = diff(
      'docs/mcp-capabilities.md',
      'capability',
      documented.filter((name) => !served.has(name)),
      capabilities,
    );
    expect(problems).toEqual([]);
  });

  it('names only metrics that exist in the backend source', () => {
    const metrics = listItemCodeNames(
      section(mcpDoc, '## Metrics and audit'),
    ).filter((name) => name.startsWith('alcantara_'));
    expect(metrics.length).toBeGreaterThan(0);
    const source = sourceFiles(join(__dirname, '..'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const missing = metrics
      .filter(
        (name) =>
          !source.includes(`'${name}'`) && !source.includes(`"${name}"`),
      )
      .map(
        (name) =>
          `docs/mcp.md names metric \`${name}\` that no backend source defines`,
      );
    expect(missing).toEqual([]);
  });

  describe('the checker itself', () => {
    const table = [
      '| Tool | Permission |',
      '|---|---|',
      '| `real_tool` | `a` |',
      '| `ghost_tool` | `b` |',
    ].join('\n');

    it('reports a documented name the registry lacks, naming tool and file', () => {
      expect(
        diff('docs/x.md', 'tool', firstCellNames(table), ['real_tool']),
      ).toEqual(['docs/x.md names tool `ghost_tool` that is not registered']);
    });

    it('reports a registered name the doc omits, naming tool and file', () => {
      expect(
        diff('docs/x.md', 'tool', firstCellNames(table), [
          'real_tool',
          'ghost_tool',
          'missing_tool',
        ]),
      ).toEqual(['docs/x.md omits registered tool `missing_tool`']);
    });

    it('reads only the first cell, splits comma names and ignores prose rows', () => {
      expect(
        firstCellNames('| `a,b` | `c` |\n| plain | `d` |\ntext `e`'),
      ).toEqual(['a', 'b']);
    });

    it('reads list-item metric names and rejects a missing heading', () => {
      expect(
        listItemCodeNames('- `m_one{x}` counts\n- `m_two` counts\n  `m_three`'),
      ).toEqual(['m_one', 'm_two']);
      expect(() => section('# a', '## nope')).toThrow('heading not found');
      expect(section('## a\nx\n### b\ny\n## c\nz', '## a')).toBe('x\n### b\ny');
    });
  });
});
