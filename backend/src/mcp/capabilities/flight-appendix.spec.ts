import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { ProgramController } from '../../program/program.controller';
import { UNTRUSTED_NOTE } from '../contract';
import { FlightMcpTools } from './flight';

// The rows of gaulatti/alcantara#210 appendix A that belong to ticket #215,
// read from the tracker's own file: the program flight routes. Names, tiers
// and permissions are binding; a row that looks wrong against the code is
// reported, never adjusted here.
const ROWS = readFileSync(join(__dirname, '..', 'appendix-a.tsv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split('\t'))
  .filter(([, , path]) => /\/flight(\/|$)/.test(path))
  // The write, on-air and destructive rows land in the next commit.
  .filter(([, , , , , , tier]) => tier === 'R');

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  return (
    ALCANTARA_PERMISSIONS as unknown as Record<string, Record<string, string>>
  )[group][action];
};

const specs = new FlightMcpTools({} as never).specs();

describe('appendix A rows of ticket #215 (flight)', () => {
  it('has the rows the ticket names, none of them excluded', () => {
    expect(ROWS).toHaveLength(2);
    expect(ROWS.every((row) => !row[6].startsWith('excluded'))).toBe(true);
  });

  it.each(ROWS)(
    '%s %s %s needs %s and is capability %s (tier %s)',
    (_area, _method, _path, permission, _handler, name, tier) => {
      const spec = specs.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.permission).toBe(permissionOf(permission));
      expect(spec?.tier).toBe(tier);
      expect(spec?.firstClass).toBe(false);
    },
  );

  it.each(ROWS)(
    '%s %s %s: the permission is the one the controller handler requires',
    (_area, _method, _path, _permission, handler, name) => {
      const prototype = ProgramController.prototype as unknown as Record<
        string,
        object
      >;
      expect(specs.find((spec) => spec.name === name)?.permission).toBe(
        Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype[handler]),
      );
    },
  );

  it('registers exactly those rows, once each', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ROWS.map((row) => row[5]).sort(),
    );
  });

  it('gives every A and D capability a dry run and a confirm target, and every W a dry run', () => {
    for (const spec of specs) {
      expect(spec.dryRun !== undefined).toBe(spec.tier !== 'R');
      expect(spec.confirmTarget !== undefined).toBe(
        spec.tier === 'A' || spec.tier === 'D',
      );
    }
  });

  it('ends every description with the untrusted note', () => {
    for (const spec of specs)
      expect(spec.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
  });
});
