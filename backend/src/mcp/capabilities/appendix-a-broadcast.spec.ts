import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { BroadcastDestinationsController } from '../../broadcast-destinations/broadcast-destinations.controller';
import { ExternalSourcesController } from '../../external-sources/external-sources.controller';
import { FillerController } from '../../filler/filler.controller';
import { OperatorPreferencesController } from '../../operator-preferences/operator-preferences.controller';
import { RadioController } from '../../radio/radio.controller';
import { RadioMonitorController } from '../../radio/radio-monitor.controller';
import { RecordingController } from '../../recording/recording.controller';
import { TapeController } from '../../recording/tape.controller';
import { WebrtcController } from '../../webrtc/webrtc.controller';
import { UNTRUSTED_NOTE } from '../contract';
import { BroadcastDestinationsMcpTools } from './destinations';
import { ExternalSourcesMcpTools } from './external-sources';
import { FillerMcpTools } from './filler';
import { OperatorPreferencesMcpTools } from './preferences';
import { RadioMcpTools } from './radio';
import { RecordingMcpTools } from './recording';
import { WebrtcMcpTools } from './webrtc';

// The closing test of gaulatti/alcantara#219: the rows of appendix A
// (backend/src/mcp/appendix-a.tsv) for broadcast destinations, filler,
// recording and tape, radio (settings, Palazzo, output confidence, recovery,
// now-playing consumers, manual song and instant), operator preferences,
// external sources and guests (webrtc). Two groups of rows are not this
// ticket's: the radio similarity rows (ticket 218) and the rows marked
// excluded because they return or produce a credential (seven rows in all:
// the realtime, monitor and download tickets, the source credential rotation,
// the guest link of create and replace invitation, and the operator token).

const AREAS = new Set([
  'broadcast-destinations',
  'filler',
  'recording',
  'radio',
  'operator-preferences',
  'external-sources',
  'webrtc',
]);
const NOT_THIS_TICKET = (capability: string) =>
  capability.startsWith('radio_similarity_');

type Row = [
  area: string,
  method: string,
  path: string,
  permission: string,
  handler: string,
  capability: string,
  tier: string,
];

const all = readFileSync(join(__dirname, '..', 'appendix-a.tsv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split('\t') as Row)
  .filter((row) => AREAS.has(row[0]));
const excludedRows = all.filter((row) => row[6].startsWith('excluded'));
const ROWS = all.filter(
  (row) => !row[6].startsWith('excluded') && !NOT_THIS_TICKET(row[5]),
);

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  const entry = (ALCANTARA_PERMISSIONS as Record<string, unknown>)[group];
  return typeof entry === 'string'
    ? entry
    : (entry as Record<string, string>)[action];
};

const specs = [
  ...new BroadcastDestinationsMcpTools({} as never).specs(),
  ...new FillerMcpTools({} as never).specs(),
  ...new RecordingMcpTools({} as never).specs(),
  ...new RadioMcpTools(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ).specs(),
  ...new OperatorPreferencesMcpTools(
    {} as never,
    {} as never,
    {} as never,
  ).specs(),
  ...new ExternalSourcesMcpTools({} as never, {} as never, {} as never).specs(),
  ...new WebrtcMcpTools({} as never, {} as never).specs(),
];

const controllerOf = (area: string, path: string) =>
  ({
    'broadcast-destinations': BroadcastDestinationsController,
    filler: FillerController,
    recording: path.includes('/tape') ? TapeController : RecordingController,
    radio: RadioController,
    'operator-preferences': OperatorPreferencesController,
    'external-sources': ExternalSourcesController,
    webrtc: WebrtcController,
  })[area] as unknown as { prototype: Record<string, unknown> };

describe('appendix A rows of ticket #219', () => {
  it('has a row for every route of its areas that is not excluded', () => {
    expect(ROWS).toHaveLength(57);
    const count = (area: string) =>
      ROWS.filter((row) => row[0] === area).length;
    expect([...AREAS].map((area) => [area, count(area)])).toEqual([
      ['broadcast-destinations', 11],
      ['filler', 3],
      ['recording', 6],
      ['radio', 16],
      ['operator-preferences', 8],
      ['external-sources', 7],
      ['webrtc', 6],
    ]);
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
    (area, _method, path, _permission, handler, name) => {
      const controller = controllerOf(area, path);
      const required =
        (Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          controller.prototype[handler] as object,
        ) as string | undefined) ??
        (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller) as string);
      expect(specs.find((spec) => spec.name === name)?.permission).toBe(
        required,
      );
    },
  );

  it('registers exactly those rows, once each', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ROWS.map((row) => row[5]).sort(),
    );
  });

  it('has the counted rows per tier', () => {
    const tiers = ROWS.map((row) => row[6]);
    for (const [tier, n] of [
      ['R', 19],
      ['W', 13],
      ['A', 19],
      ['D', 6],
    ] as const)
      expect(tiers.filter((t) => t === tier)).toHaveLength(n);
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

  it('keeps the seven excluded rows out', () => {
    // In this ticket's areas: the monitor and download tickets, the rotation,
    // both guest-link rows and the operator token.
    expect(excludedRows.map((row) => row[4]).sort()).toEqual([
      'createInvitation',
      'issue',
      'issue',
      'operatorToken',
      'replaceInvitation',
      'rotate',
    ]);
    for (const row of excludedRows) expect(row[5]).toBe('—');
    for (const spec of specs) {
      expect(spec.name).not.toMatch(
        /ticket|credential|rotate|token|create_invitation|replace_invitation/,
      );
    }
    // The routes themselves are still the ones appendix A names.
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- only the decorator metadata of the method is read.
        RadioMonitorController.prototype.issue,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.radio.read);
  });

  it('leaves the similarity rows to their own ticket', () => {
    expect(
      specs.some((spec) => spec.name.startsWith('radio_similarity_')),
    ).toBe(false);
  });
});
