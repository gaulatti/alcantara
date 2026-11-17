import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  ProgramTemplateService,
  validateProgramTemplateManifest,
} from './program-template.service';

// gaulatti/ariston#217: a template manifest that names a signal or capability
// Alcantara does not know is registered without it, not refused. The required
// members, versions and integrity checks stay strict.

type TestableProgramTemplateService = ProgramTemplateService & {
  resolveHost: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  fetchManifest: typeof fetch;
};

const v2Manifest = () => ({
  kind: 'alcantara.program-template',
  contractVersion: 2,
  id: 'harbor-light.live-program',
  name: 'Harbor Light Live Program',
  package: '@harbor-light/template',
  bundleVersion: '1.0.0',
  schemaVersion: 2,
  entrypoint: 'index.html',
  capabilities: ['audio.playback', 'telepathy.secret-capability'],
  control: {
    protocol: 'alcantara.program.v2',
    transport: 'server-sent-events',
    snapshotPath: 'state',
    eventsPath: 'events',
    runtimeParameters: { programId: 'programId', apiBaseUrl: 'apiBaseUrl' },
    signals: [
      'program_state_snapshot',
      'chyron_update',
      'secret_future_signal',
      'another_future_signal',
    ],
  },
});

function serviceReturning(body: unknown) {
  const metrics = new ManagedMetricsService();
  const service = new ProgramTemplateService(metrics);
  const testable = service as TestableProgramTemplateService;
  testable.resolveHost = jest
    .fn()
    .mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  testable.fetchManifest = jest.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
  return { service, metrics };
}

async function unknownSeries(metrics: ManagedMetricsService) {
  const text = await metrics.registry.metrics();
  return text
    .split('\n')
    .filter((line) =>
      line.startsWith('alcantara_program_template_unknowns_ignored_total{'),
    );
}

const url = 'https://templates.harborlight.test/live-program-manifest.json';

describe('ProgramTemplateService: unknown manifest members', () => {
  it('registers the template with only the signals and capabilities Alcantara knows', async () => {
    const { service, metrics } = serviceReturning(v2Manifest());

    const registration = await service.inspect(url);

    expect(registration.templateManifest.control.signals).toEqual([
      'program_state_snapshot',
      'chyron_update',
    ]);
    expect(registration.templateManifest.capabilities).toEqual([
      'audio.playback',
    ]);
    expect(await unknownSeries(metrics)).toEqual([
      'alcantara_program_template_unknowns_ignored_total{member="signal"} 2',
      'alcantara_program_template_unknowns_ignored_total{member="capability"} 1',
      'alcantara_program_template_unknowns_ignored_total{member="property"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="control-property"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="runtime-parameter"} 0',
    ]);
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('secret_future_signal');
    expect(text).not.toContain('telepathy.secret-capability');
  });

  it('exposes every member series from 0 before any manifest is read', async () => {
    expect(await unknownSeries(new ManagedMetricsService())).toEqual([
      'alcantara_program_template_unknowns_ignored_total{member="signal"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="capability"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="property"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="control-property"} 0',
      'alcantara_program_template_unknowns_ignored_total{member="runtime-parameter"} 0',
    ]);
  });

  // Slice 4a: unknown top-level, control and runtime parameter members.
  it('registers a manifest with unknown members, stores none of them and counts each', async () => {
    const body = {
      ...v2Manifest(),
      secretTopLevel: { nested: true },
      control: {
        ...v2Manifest().control,
        secretControl: 'x',
        runtimeParameters: {
          ...v2Manifest().control.runtimeParameters,
          secretParameter: 'theme',
        },
      },
    };
    const { service, metrics } = serviceReturning(body);

    const registration = await service.inspect(url);

    const stored = JSON.stringify(registration.templateManifest);
    expect(stored).not.toMatch(/secret/);
    expect(registration.templateManifest.control.runtimeParameters).toEqual({
      programId: 'programId',
      apiBaseUrl: 'apiBaseUrl',
    });
    expect(await unknownSeries(metrics)).toEqual([
      'alcantara_program_template_unknowns_ignored_total{member="signal"} 2',
      'alcantara_program_template_unknowns_ignored_total{member="capability"} 1',
      'alcantara_program_template_unknowns_ignored_total{member="property"} 1',
      'alcantara_program_template_unknowns_ignored_total{member="control-property"} 1',
      'alcantara_program_template_unknowns_ignored_total{member="runtime-parameter"} 1',
    ]);
    expect(await metrics.registry.metrics()).not.toMatch(/secret/);
  });

  it.each([
    [
      'a missing runtime parameter',
      {
        ...v2Manifest(),
        control: {
          ...v2Manifest().control,
          runtimeParameters: { programId: 'programId', theme: 'x' },
        },
      },
      'control.runtimeParameters.apiBaseUrl',
    ],
    [
      'a missing control member',
      {
        ...v2Manifest(),
        control: { ...v2Manifest().control, eventsPath: undefined, extra: 1 },
      },
      'control.eventsPath',
    ],
    [
      'a missing top-level member',
      { ...v2Manifest(), entrypoint: undefined, extra: 1 },
      'entrypoint',
    ],
  ])(
    'still refuses %s alongside unknown members',
    async (_name, body, message) => {
      const { service } = serviceReturning(body);
      await expect(service.inspect(url)).rejects.toThrow(message);
    },
  );

  it('drops a v2-only signal from a v1 manifest', () => {
    const v1 = {
      ...v2Manifest(),
      contractVersion: 1,
      schemaVersion: 1,
      capabilities: ['anything.v1'],
      control: {
        ...v2Manifest().control,
        protocol: 'alcantara.program.v1',
        signals: ['program_state_snapshot', 'chyron_update'],
      },
    };
    const seen: string[] = [];
    const result = validateProgramTemplateManifest(v1, new URL(url), (member) =>
      seen.push(member),
    );
    expect(result.control.signals).toEqual(['program_state_snapshot']);
    // v1 never had a capability allowlist; it is left as declared.
    expect(result.capabilities).toEqual(['anything.v1']);
    expect(seen).toEqual(['signal']);
  });

  it.each([
    [
      'a manifest without program_state_snapshot',
      {
        ...v2Manifest(),
        control: { ...v2Manifest().control, signals: ['secret_future_signal'] },
      },
      'must accept program_state_snapshot',
    ],
    [
      'an unknown contract version',
      { ...v2Manifest(), contractVersion: 3 },
      'Unsupported template contract version 3',
    ],
    [
      'a malformed signal name',
      {
        ...v2Manifest(),
        control: {
          ...v2Manifest().control,
          signals: ['program_state_snapshot', 'Not-A-Signal'],
        },
      },
      'control.signals is invalid',
    ],
    [
      'a duplicated capability',
      { ...v2Manifest(), capabilities: ['audio.playback', 'audio.playback'] },
      'capabilities contains duplicates',
    ],
  ])('still refuses %s', async (_name, body, message) => {
    const { service } = serviceReturning(body);
    await expect(service.inspect(url)).rejects.toThrow(message);
  });
});
