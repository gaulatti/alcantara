import {
  ProgramTemplateService,
  isPublicNetworkAddress,
  projectProgramTemplateSignal,
  projectProgramTemplateState,
  validateProgramTemplateManifest,
  readProgramTemplateManifest,
  PROGRAM_TEMPLATE_SIGNALS,
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

describe('ProgramTemplateService manifest/network and renderer protocol boundaries', () => {
  let previousEnvironment: string | undefined;
  beforeEach(() => {
    previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });
  const manifestUrl = new URL(
    'https://cdn.example.test/releases/manifest.json',
  );
  const valid = () => structuredClone(manifest);
  function controlled() {
    const service =
      new ProgramTemplateService() as TestableProgramTemplateService;
    const dns = jest
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const request = jest
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(manifest), {
            headers: { 'content-type': 'application/json' },
          }),
      );
    service.resolveHost = dns;
    service.fetchManifest = request;
    return { service, dns, request };
  }

  it.each([
    { value: null },
    { value: [] },
    { value: 'manifest' },
    { override: { kind: 'other' } },
    { override: { contractVersion: 2 } },
    { override: { schemaVersion: 2 } },
    { override: { id: 'Bad ID' } },
    { override: { name: '' } },
    { override: { name: 'x'.repeat(201) } },
    { override: { capabilities: ['audio.playback', 'audio.playback'] } },
    { override: { capabilities: new Array(65).fill('audio.playback') } },
    { override: { control: null } },
  ])(
    'rejects malformed or incompatible manifest shape: %p',
    async (testCase) => {
      const value =
        'value' in testCase
          ? testCase.value
          : { ...valid(), ...testCase.override };
      expect(() =>
        validateProgramTemplateManifest(value, manifestUrl),
      ).toThrow();
    },
  );

  it.each([
    '/index.html',
    'part\\index.html',
    'index.html?token=1',
    'index.html#secret',
    './index.html',
    '../index.html',
    'https://other.example/index.html',
  ])('rejects an unsafe/cross-origin template entrypoint: %s', (entrypoint) => {
    expect(() =>
      validateProgramTemplateManifest({ ...valid(), entrypoint }, manifestUrl),
    ).toThrow();
  });

  it.each([
    { protocol: 'other' },
    { transport: 'websocket' },
    { runtimeParameters: null },
    { snapshotPath: 'other' },
    { eventsPath: 'other' },
    { runtimeParameters: { programId: 'bad-param', apiBaseUrl: 'apiBaseUrl' } },
    { signals: ['program_state_snapshot', 'program_state_snapshot'] },
    { signals: ['Not_a_signal'] },
  ])(
    'rejects incompatible or unsafe renderer control contracts: %p',
    (control) => {
      expect(() =>
        validateProgramTemplateManifest(
          { ...valid(), control: { ...manifest.control, ...control } },
          manifestUrl,
        ),
      ).toThrow();
    },
  );

  it.each([
    { address: 'not-an-address', allowed: false },
    { address: '0.0.0.0', allowed: false },
    { address: '100.64.0.1', allowed: false },
    { address: '100.127.255.255', allowed: false },
    { address: '100.63.255.255', allowed: true },
    { address: '100.128.0.1', allowed: true },
    { address: '172.16.0.1', allowed: false },
    { address: '172.31.255.255', allowed: false },
    { address: '172.15.255.255', allowed: true },
    { address: '172.32.0.1', allowed: true },
    { address: '192.0.0.1', allowed: false },
    { address: '192.0.2.1', allowed: false },
    { address: '192.0.1.1', allowed: true },
    { address: '192.168.0.1', allowed: false },
    { address: '198.18.0.1', allowed: false },
    { address: '198.19.0.1', allowed: false },
    { address: '198.51.100.1', allowed: false },
    { address: '198.51.101.1', allowed: true },
    { address: '203.0.114.1', allowed: true },
    { address: '224.0.0.1', allowed: false },
    { address: '::', allowed: false },
    { address: 'fc00::1', allowed: false },
    { address: 'fd00::1', allowed: false },
    { address: 'fe80::1', allowed: false },
    { address: 'ff02::1', allowed: false },
    { address: '::ffff:127.0.0.1', allowed: false },
    { address: '::ffff:1.1.1.1', allowed: true },
  ])(
    'classifies actual special/public network boundary $address',
    ({ address, allowed }) => {
      expect(isPublicNetworkAddress(address)).toBe(allowed);
    },
  );

  it.each([
    { value: null },
    { override: { kind: 'other' } },
    { override: { contractVersion: 2 } },
    { override: { entrypointUrl: 7 } },
    { override: { capabilities: null } },
    { override: { control: null } },
    { override: { control: { signals: null } } },
  ])(
    'refuses incomplete persisted manifests at the renderer boundary: %p',
    (testCase) => {
      const accepted = validateProgramTemplateManifest(valid(), manifestUrl);
      const candidate =
        'value' in testCase
          ? testCase.value
          : { ...accepted, ...testCase.override };
      expect(readProgramTemplateManifest(candidate)).toBeNull();
      expect(readProgramTemplateManifest(accepted)).toBe(accepted);
    },
  );

  it.each([
    { value: null },
    { value: [] },
    { value: {} },
    { value: { type: 7 } },
  ])('ignores malformed renderer signal input: %p', ({ value }) => {
    expect(
      projectProgramTemplateSignal(
        value,
        validateProgramTemplateManifest(valid(), manifestUrl),
      ),
    ).toBeNull();
  });

  it('projects every declared signal family while withholding private state and unknown fields', () => {
    const accepted = validateProgramTemplateManifest(
      {
        ...valid(),
        control: {
          ...manifest.control,
          signals: [...PROGRAM_TEMPLATE_SIGNALS],
        },
      },
      manifestUrl,
    );
    for (const type of accepted.control.signals) {
      const event = {
        type,
        programId: 'news',
        version: 3,
        state: { programId: 'news', activeSceneId: 7, secret: 'private' },
        scene: { id: 7, layout: { id: 2 }, chyronText: 'Live', metadata: '{}' },
        settings: { enabled: true },
        updatedAt: 'timestamp',
        sentAt: 'timestamp',
        instant: { id: 8 },
        triggeredAt: 'timestamp',
        sceneId: 7,
        instantId: 8,
        fadeMs: 100,
        loop: false,
        playback: { token: 'renderer' },
        stagedSceneId: 7,
        secret: 'private',
      };
      const projected = projectProgramTemplateSignal(event, accepted);
      expect(projected).toMatchObject({
        type,
        programId: 'news',
        version: 3,
        schemaVersion: 1,
      });
      expect(projected).not.toHaveProperty('secret');
      if (
        [
          'scene_change',
          'program_scenes_changed',
          'program_media_groups_changed',
          'program_stingers_changed',
        ].includes(type)
      )
        expect((projected as any).state).not.toHaveProperty('secret');
    }
    expect(
      projectProgramTemplateSignal({ type: 'scene_change' }, accepted),
    ).toBeNull();
    expect(projectProgramTemplateState({ fadeToBlack: true })).toMatchObject({
      activeSceneId: null,
      activeScene: null,
      stagedSceneId: null,
      stagedScene: null,
      fadeToBlack: true,
    });
  });

  it.each([
    'not absolute',
    'http://public.example/manifest.json',
    'https://user@public.example/manifest.json',
    'https://:pass@public.example/manifest.json',
    'https://public.example/manifest.json?token=1',
    'https://public.example/manifest.json#hash',
  ])('rejects unsafe manifest URLs before fetching: %s', async (url) => {
    const f = controlled();
    await expect(f.service.inspect(url)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['http://localhost/manifest.json', 'http://127.0.0.1/manifest.json'])(
    'allows an actual local development fixture without attempting DNS: %s',
    async (url) => {
      const f = controlled();
      expect((await f.service.inspect(url)).templateUrl).toBe(url);
      expect(f.dns).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://localhost/manifest.json',
    'https://publisher.local/manifest.json',
  ])(
    'rejects special local DNS names before attempting resolution or fetch: %s',
    async (url) => {
      const f = controlled();
      await expect(f.service.inspect(url)).rejects.toThrow(
        'public network address',
      );
      expect(f.dns).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { addresses: [] },
    { addresses: [{ address: '1.1.1.1' }, { address: '10.0.0.1' }] },
  ])(
    'refuses empty or mixed public/private DNS resolution: %p',
    async ({ addresses }) => {
      const f = controlled();
      f.dns.mockResolvedValue(addresses);
      await expect(
        f.service.inspect('https://publisher.example/manifest.json'),
      ).rejects.toThrow('only to public');
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it('reports DNS and transport failure without leaking their internal diagnostics', async () => {
    const f = controlled();
    f.dns.mockRejectedValueOnce(new Error('private DNS diagnostic'));
    await expect(
      f.service.inspect('https://publisher.example/manifest.json'),
    ).rejects.toThrow('host could not be resolved');
    f.request.mockRejectedValueOnce(new Error('private transport diagnostic'));
    await expect(
      f.service.inspect('https://publisher.example/manifest.json'),
    ).rejects.toThrow('could not be fetched');
  });

  it('follows bounded relative redirects and revalidates each actual destination', async () => {
    const f = controlled();
    f.request.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: '../current.json' },
      }),
    );
    const result = await f.service.inspect(
      'https://publisher.example/releases/manifest.json',
    );
    expect(result.templateUrl).toBe('https://publisher.example/current.json');
    expect(f.dns).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(result.templateManifest.entrypointUrl).toBe(
      'https://publisher.example/index.html',
    );
  });

  it('refuses a redirect to a newly unsafe destination before its second fetch', async () => {
    const f = controlled();
    f.request.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: 'https://169.254.169.254/manifest.json' },
      }),
    );
    await expect(
      f.service.inspect('https://publisher.example/manifest.json'),
    ).rejects.toThrow('public network address');
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing redirect location and a real redirect loop at the declared maximum', async () => {
    const f = controlled();
    f.request.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(
      f.service.inspect('https://publisher.example/manifest.json'),
    ).rejects.toThrow('redirect');
    f.request.mockClear();
    f.request.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'manifest.json' },
        }),
    );
    await expect(
      f.service.inspect('https://publisher.example/manifest.json'),
    ).rejects.toThrow('redirect');
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it.each([
    'http',
    'content-type',
    'missing-content-type',
    'declared-size',
    'invalid-json',
    'missing-body',
    'read-error',
  ])(
    'rejects an invalid %s response before accepting any registration',
    async (failure) => {
      const f = controlled();
      let response: Response;
      if (failure === 'http')
        response = new Response('unavailable', { status: 503 });
      else if (failure === 'content-type')
        response = new Response('{}', {
          headers: { 'content-type': 'text/plain' },
        });
      else if (failure === 'missing-content-type')
        response = new Response(new Uint8Array([1]));
      else if (failure === 'declared-size')
        response = new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(256 * 1024 + 1),
          },
        });
      else if (failure === 'missing-body')
        response = new Response(null, {
          headers: { 'content-type': 'application/json' },
        });
      else if (failure === 'read-error')
        response = new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('read failed'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      else
        response = new Response('invalid JSON', {
          headers: { 'content-type': 'application/json' },
        });
      f.request.mockResolvedValueOnce(response);
      await expect(
        f.service.inspect('https://publisher.example/manifest.json'),
      ).rejects.toThrow();
    },
  );
});
