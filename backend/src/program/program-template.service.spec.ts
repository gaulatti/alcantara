import {
  ProgramTemplateService,
  isPublicNetworkAddress,
  projectProgramTemplateSignal,
  projectProgramTemplateState,
  validateProgramTemplateManifest,
} from './program-template.service';

const manifest = {
  kind: 'alcantara.program-template',
  contractVersion: 1,
  id: 'fifthbell.live-program',
  name: 'Fifthbell Live Program',
  package: '@fifthbell/brokaw',
  bundleVersion: '0.1.65',
  schemaVersion: 1,
  entrypoint: 'index.html',
  capabilities: ['audio.playback', 'scene.configuration'],
  control: {
    protocol: 'alcantara.program.v1',
    transport: 'server-sent-events',
    snapshotPath: 'state',
    eventsPath: 'events',
    runtimeParameters: {
      programId: 'programId',
      apiBaseUrl: 'apiBaseUrl',
    },
    signals: ['program_state_snapshot', 'scene_change'],
  },
};

type TestableProgramTemplateService = ProgramTemplateService & {
  resolveHost: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  fetchManifest: typeof fetch;
};

describe('ProgramTemplateService', () => {
  it('normalizes the entrypoint and declared capabilities', () => {
    expect(
      validateProgramTemplateManifest(
        manifest,
        new URL(
          'https://cdn.fifthbell.com/html/program-releases/0.1.65/live-program-manifest.json',
        ),
      ),
    ).toMatchObject({
      id: 'fifthbell.live-program',
      entrypointUrl:
        'https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html',
      capabilities: ['audio.playback', 'scene.configuration'],
    });
  });

  it('rejects missing capabilities and server-unknown signals', () => {
    expect(() =>
      validateProgramTemplateManifest(
        { ...manifest, capabilities: [] },
        new URL('https://cdn.example.test/manifest.json'),
      ),
    ).toThrow('capabilities must be a non-empty array');
    expect(() =>
      validateProgramTemplateManifest(
        {
          ...manifest,
          control: { ...manifest.control, signals: ['dump_operator_state'] },
        },
        new URL('https://cdn.example.test/manifest.json'),
      ),
    ).toThrow('requests unsupported signal dump_operator_state');
    expect(() =>
      validateProgramTemplateManifest(
        {
          ...manifest,
          control: { ...manifest.control, signals: ['scene_change'] },
        },
        new URL('https://cdn.example.test/manifest.json'),
      ),
    ).toThrow('must accept program_state_snapshot');
  });

  it('classifies private, loopback, documentation, and public addresses', () => {
    expect(isPublicNetworkAddress('127.0.0.1')).toBe(false);
    expect(isPublicNetworkAddress('10.0.0.8')).toBe(false);
    expect(isPublicNetworkAddress('169.254.169.254')).toBe(false);
    expect(isPublicNetworkAddress('203.0.113.8')).toBe(false);
    expect(isPublicNetworkAddress('::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:db8::1')).toBe(false);
    expect(isPublicNetworkAddress('1.1.1.1')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('fetches a bounded JSON manifest after validating the destination', async () => {
    const metrics = { recordDependency: jest.fn() };
    const service = new ProgramTemplateService(metrics as never);
    const testable = service as TestableProgramTemplateService;
    testable.resolveHost = jest
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const fetchManifest = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    testable.fetchManifest = fetchManifest as unknown as typeof fetch;

    const result = await service.inspect(
      'https://cdn.fifthbell.com/templates/live-program-manifest.json',
    );

    expect(result.templateManifest.entrypointUrl).toBe(
      'https://cdn.fifthbell.com/templates/index.html',
    );
    expect(fetchManifest).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'program-template',
      'fetch',
      'success',
      expect.any(Number),
    );
  });

  it('rejects private manifest destinations before fetching', async () => {
    const metrics = { recordDependency: jest.fn() };
    const service = new ProgramTemplateService(metrics as never);
    const testable = service as TestableProgramTemplateService;
    const fetchManifest = jest.fn();
    testable.fetchManifest = fetchManifest as unknown as typeof fetch;

    await expect(
      service.inspect('https://169.254.169.254/template.json'),
    ).rejects.toThrow('public network address');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'program-template',
      'fetch',
      'failure',
      expect.any(Number),
    );
  });

  it('stops reading a manifest that exceeds the response limit', async () => {
    const service = new ProgramTemplateService();
    const testable = service as TestableProgramTemplateService;
    testable.resolveHost = jest
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    testable.fetchManifest = jest.fn().mockResolvedValue(
      new Response(Buffer.alloc(256 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await expect(
      service.inspect('https://cdn.fifthbell.com/templates/manifest.json'),
    ).rejects.toThrow('too large');
  });

  it('accepts only the Cronkite CDN publisher in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const service = new ProgramTemplateService();
    const testable = service as TestableProgramTemplateService;
    const fetchManifest = jest.fn();
    testable.fetchManifest = fetchManifest as unknown as typeof fetch;

    try {
      await expect(
        service.inspect('https://templates.example.test/manifest.json'),
      ).rejects.toThrow('not an approved program-template publisher');
      expect(fetchManifest).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('projects only renderer state and manifest-approved signal fields', () => {
    const validated = validateProgramTemplateManifest(
      manifest,
      new URL('https://cdn.fifthbell.com/template/manifest.json'),
    );
    const state = projectProgramTemplateState({
      id: 7,
      programId: 'fifthbell',
      activeSceneId: 34,
      activeScene: {
        id: 34,
        name: 'Live',
        layoutId: 4,
        layout: {
          id: 4,
          name: 'Fifthbell',
          componentType: 'fifthbell',
          settings: '{}',
          internalOnly: 'hidden',
        },
        chyronText: null,
        metadata: '{}',
        internalOnly: 'hidden',
      },
      stagedSceneId: null,
      stagedScene: null,
      fadeToBlack: false,
      updatedAt: '2026-09-08T18:00:00.000Z',
      version: 8,
      songSequence: { privateQueue: true },
      templateManifest: validated,
    });

    expect(state).not.toHaveProperty('songSequence');
    expect(state).not.toHaveProperty('templateManifest');
    expect(state.activeScene).not.toHaveProperty('internalOnly');
    const activeScene = state.activeScene as {
      layout: Record<string, unknown>;
    };
    expect(activeScene.layout).not.toHaveProperty('internalOnly');

    expect(
      projectProgramTemplateSignal(
        {
          type: 'scene_change',
          programId: 'fifthbell',
          version: 9,
          transitionId: 'cut',
          state: { ...state, secret: 'hidden' },
          secret: 'hidden',
        },
        validated,
      ),
    ).toMatchObject({
      type: 'scene_change',
      schemaVersion: 1,
      version: 9,
      transitionId: 'cut',
    });
    expect(
      projectProgramTemplateSignal(
        { type: 'operator_snapshot', secret: 'hidden' },
        validated,
      ),
    ).toBeNull();
  });
});
