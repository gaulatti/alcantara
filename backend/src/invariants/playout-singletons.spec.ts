import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * alcantara#873: only the instance holding the playout lease runs writers and schedulers. A provider that starts a
 * repeating timer must do it through `startWhenActive`, or be listed here with the reason it is safe on a standby.
 * A new `setInterval` outside both fails this check, so the inventory cannot drift.
 */
const SAFE_ON_A_STANDBY: Record<string, string> = {
  'playout/playout-lease.service.ts': 'the lease itself: its liveness probe',
  'program/program.service.ts':
    'per-connection SSE heartbeats; streams exist only once requests are served',
  'radio/radio-output-confidence.service.ts':
    'judges engine events, which only the active engine emits',
  'radio/palazzo-program.client.ts':
    'created by Palazzo telemetry, which starts only when active',
  'radio/song-execution.engine.ts':
    'the watchdog starts inside takeOver(), which runs only when active',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('playout singletons (alcantara#873)', () => {
  it('starts every repeating timer through the playout lease, or names why it is safe on a standby', () => {
    const root = join(__dirname, '..');
    const ungated = sources(root)
      .map((file) => ({
        file: relative(root, file),
        text: readFileSync(file, 'utf8'),
      }))
      .filter(({ text }) => text.includes('setInterval('))
      .filter(
        ({ file, text }) =>
          !text.includes('startWhenActive(') && !SAFE_ON_A_STANDBY[file],
      )
      .map(({ file }) => file);
    expect(ungated).toEqual([]);
  });

  it('lists only files that still start a timer', () => {
    const root = join(__dirname, '..');
    for (const file of Object.keys(SAFE_ON_A_STANDBY)) {
      expect(readFileSync(join(root, file), 'utf8')).toContain('setInterval(');
    }
  });
});
