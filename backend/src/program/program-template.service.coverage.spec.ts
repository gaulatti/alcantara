import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_PRODUCTION_TEMPLATE_ORIGINS,
  PROGRAM_TEMPLATE_SIGNALS,
  PROGRAM_TEMPLATE_V2_CAPABILITIES,
  PROGRAM_TEMPLATE_V2_SIGNALS,
  ProgramTemplateService,
  V2_ONLY_SIGNALS,
  getApprovedTemplateOrigins,
  isPublicNetworkAddress,
  projectProgramTemplateSignal,
  projectProgramTemplateState,
  readProgramTemplateManifest,
  validateProgramTemplateManifest,
  type ProgramTemplateManifest,
} from './program-template.service';

const baseManifest = () => ({
  kind: 'alcantara.program-template',
  contractVersion: 1,
  id: 'fifthbell.live-program',
  name: 'Fifthbell Live Program',
  package: '@fifthbell/brokaw',
  bundleVersion: '0.1.65',
  schemaVersion: 1,
  entrypoint: 'index.html',
  capabilities: ['audio.playback'],
  control: {
    protocol: 'alcantara.program.v1',
    transport: 'server-sent-events',
    snapshotPath: 'state',
    eventsPath: 'events',
    runtimeParameters: { programId: 'programId', apiBaseUrl: 'apiBaseUrl' },
    signals: ['program_state_snapshot', 'scene_change'],
  },
});
const baseV2Manifest = () => ({
  kind: 'alcantara.program-template',
  contractVersion: 2,
  id: 'harbor-light.live-program',
  name: 'Harbor Light Live Program',
  package: '@harbor-light/template',
  bundleVersion: '1.0.0',
  schemaVersion: 2,
  entrypoint: 'index.html',
  capabilities: ['audio.playback', 'sequence.song'],
  control: {
    protocol: 'alcantara.program.v2',
    transport: 'server-sent-events',
    snapshotPath: 'state',
    eventsPath: 'events',
    runtimeParameters: { programId: 'programId', apiBaseUrl: 'apiBaseUrl' },
    signals: [
      'program_state_snapshot',
      'chyron_update',
      'fade_to_black',
      'song_playback_active',
      'song_playback_update',
      'song_queue_update',
      'audio_levels',
      'audience_interaction_draw_start',
      'audience_interaction_draw_end',
    ],
  },
  files: [
    {
      key: 'index.html',
      bytes: 1024,
      contentType: 'text/html',
      sha256: 'a'.repeat(64),
    },
  ],
});
const manifestUrl = new URL('https://cdn.fifthbell.com/t/manifest.json');
const withControl = (control: Record<string, unknown>) => ({
  ...baseManifest(),
  control: { ...baseManifest().control, ...control },
});
const validate = (value: unknown) =>
  validateProgramTemplateManifest(value, manifestUrl);

describe('validateProgramTemplateManifest rejections', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'manifest'],
  ])('rejects %s as not a JSON object', (_label, value) => {
    expect(() => validate(value)).toThrow(
      'Template manifest must be a JSON object',
    );
  });

  it('rejects the wrong kind, contract version and schema version', () => {
    expect(() => validate({ ...baseManifest(), kind: 'other' })).toThrow(
      'Template manifest kind must be alcantara.program-template',
    );
    expect(() => validate({ ...baseManifest(), contractVersion: 3 })).toThrow(
      'Unsupported template contract version 3',
    );
    expect(() =>
      validate({ ...baseManifest(), contractVersion: undefined }),
    ).toThrow('Unsupported template contract version undefined');
    expect(() => validate({ ...baseManifest(), schemaVersion: 3 })).toThrow(
      'Unsupported program state schema version 3',
    );
  });

  it.each([
    ['missing', undefined, 'Template manifest entrypoint is required'],
    ['blank', '   ', 'Template manifest entrypoint is required'],
    ['non-string', 7, 'Template manifest entrypoint is required'],
    ['absolute', '/index.html', 'Template manifest entrypoint is invalid'],
    ['backslash', 'a\\b.html', 'Template manifest entrypoint is invalid'],
    ['query', 'index.html?x=1', 'Template manifest entrypoint is invalid'],
    ['fragment', 'index.html#x', 'Template manifest entrypoint is invalid'],
    ['dot segment', './index.html', 'Template manifest entrypoint is invalid'],
    [
      'parent segment',
      'a/../b.html',
      'Template manifest entrypoint is invalid',
    ],
    ['overlong', 'a'.repeat(201), 'Template manifest entrypoint is invalid'],
  ])('rejects a %s entrypoint', (_label, entrypoint, message) => {
    expect(() => validate({ ...baseManifest(), entrypoint })).toThrow(message);
  });

  it('rejects an entrypoint on another origin', () => {
    expect(() =>
      validate({
        ...baseManifest(),
        entrypoint: 'https://evil.example/x.html',
      }),
    ).toThrow(
      'Template manifest entrypoint must remain on the manifest origin',
    );
  });

  it('rejects malformed capability lists', () => {
    const attempt = (capabilities: unknown) =>
      validate({ ...baseManifest(), capabilities });
    expect(() => attempt('audio')).toThrow(
      'Template manifest capabilities must be a non-empty array',
    );
    expect(() =>
      attempt(Array.from({ length: 65 }, (_, i) => `c${i}`)),
    ).toThrow('capabilities must be a non-empty array');
    expect(() => attempt(['a', 'a'])).toThrow(
      'Template manifest capabilities contains duplicates',
    );
    expect(() => attempt(['Bad Token'])).toThrow(
      'Template manifest capabilities is invalid',
    );
    expect(() => attempt([''])).toThrow(
      'Template manifest capabilities is required',
    );
  });

  it('rejects an invalid control block', () => {
    expect(() => validate({ ...baseManifest(), control: null })).toThrow(
      'Template manifest control is required',
    );
    expect(() => validate(withControl({ protocol: 'v0' }))).toThrow(
      'Template manifest control protocol must be alcantara.program.v1',
    );
    expect(() => validate(withControl({ transport: 'websocket' }))).toThrow(
      'Template manifest control transport must be server-sent-events',
    );
    expect(() => validate(withControl({ runtimeParameters: [] }))).toThrow(
      'Template manifest control.runtimeParameters is required',
    );
    expect(() => validate(withControl({ snapshotPath: 'snap' }))).toThrow(
      'Template manifest control paths are unsupported',
    );
    expect(() => validate(withControl({ eventsPath: 'stream' }))).toThrow(
      'Template manifest control paths are unsupported',
    );
    expect(() => validate(withControl({ snapshotPath: '../state' }))).toThrow(
      'Template manifest control.snapshotPath is invalid',
    );
  });

  it('rejects invalid signal lists', () => {
    expect(() => validate(withControl({ signals: [] }))).toThrow(
      'Template manifest control.signals must be a non-empty array',
    );
    expect(() =>
      validate(withControl({ signals: ['heartbeat', 'heartbeat'] })),
    ).toThrow('Template manifest control.signals contains duplicates');
    expect(() => validate(withControl({ signals: ['Heart-Beat'] }))).toThrow(
      'Template manifest control.signals is invalid',
    );
    expect(() =>
      validate(withControl({ signals: ['program_state_snapshot', 'nope'] })),
    ).toThrow('Template manifest requests unsupported signal nope');
    expect(() => validate(withControl({ signals: ['heartbeat'] }))).toThrow(
      'Template manifest must accept program_state_snapshot',
    );
  });

  it('rejects invalid identity and runtime parameter fields', () => {
    expect(() => validate({ ...baseManifest(), id: 'Bad Id' })).toThrow(
      'Template manifest id is invalid',
    );
    expect(() => validate({ ...baseManifest(), name: '' })).toThrow(
      'Template manifest name is required',
    );
    expect(() =>
      validate({ ...baseManifest(), name: 'n'.repeat(201) }),
    ).toThrow('Template manifest name is invalid');
    expect(() => validate({ ...baseManifest(), package: undefined })).toThrow(
      'Template manifest package is required',
    );
    expect(() =>
      validate({ ...baseManifest(), bundleVersion: undefined }),
    ).toThrow('Template manifest bundleVersion is required');
    expect(() =>
      validate(
        withControl({
          runtimeParameters: { programId: '1x', apiBaseUrl: 'a' },
        }),
      ),
    ).toThrow(
      'Template manifest control.runtimeParameters.programId is invalid',
    );
    expect(() =>
      validate(
        withControl({
          runtimeParameters: { programId: 'p', apiBaseUrl: 'a-b' },
        }),
      ),
    ).toThrow(
      'Template manifest control.runtimeParameters.apiBaseUrl is invalid',
    );
  });

  it('trims accepted values', () => {
    const result = validate({
      ...baseManifest(),
      name: '  Padded  ',
      capabilities: [' audio.playback '],
    });
    expect(result.name).toBe('Padded');
    expect(result.capabilities).toEqual(['audio.playback']);
  });

  describe('v2 manifest validation', () => {
    it('accepts a valid v2 manifest with and without files', () => {
      const manifestUrlV2 = new URL(
        'https://template.harborlight.test/t/manifest.json',
      );
      const valid = validateProgramTemplateManifest(
        baseV2Manifest(),
        manifestUrlV2,
      );
      expect(valid.contractVersion).toBe(2);
      expect(valid.schemaVersion).toBe(2);
      expect(valid.control.protocol).toBe('alcantara.program.v2');
      expect(valid.files).toHaveLength(1);

      const noFiles = { ...baseV2Manifest() };
      delete (noFiles as Record<string, unknown>).files;
      const validNoFiles = validateProgramTemplateManifest(
        noFiles,
        manifestUrlV2,
      );
      expect(validNoFiles.files).toBeUndefined();
    });

    it('rejects invalid schemaVersion or protocol for v2', () => {
      expect(() => validate({ ...baseV2Manifest(), schemaVersion: 1 })).toThrow(
        'Unsupported program state schema version 1',
      );
      expect(() =>
        validate({
          ...baseV2Manifest(),
          control: {
            ...baseV2Manifest().control,
            protocol: 'alcantara.program.v1',
          },
        }),
      ).toThrow(
        'Template manifest control protocol must be alcantara.program.v2',
      );
    });

    it('rejects capabilities and signals outside v2 enums', () => {
      expect(() =>
        validate({
          ...baseV2Manifest(),
          capabilities: ['audio.playback', 'unsupported.capability'],
        }),
      ).toThrow(
        'Template manifest requests unsupported capability unsupported.capability',
      );
      expect(() =>
        validate({
          ...baseV2Manifest(),
          control: {
            ...baseV2Manifest().control,
            signals: ['program_state_snapshot', 'unsupported_signal'],
          },
        }),
      ).toThrow(
        'Template manifest requests unsupported signal unsupported_signal',
      );
    });

    it('rejects unrecognized properties on v2 manifest, control, and runtimeParameters', () => {
      expect(() =>
        validate({ ...baseV2Manifest(), extraField: 'bad' }),
      ).toThrow('Template manifest contains unrecognized property extraField');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          control: { ...baseV2Manifest().control, extraField: 'bad' },
        }),
      ).toThrow(
        'Template manifest control contains unrecognized property extraField',
      );
      expect(() =>
        validate({
          ...baseV2Manifest(),
          control: {
            ...baseV2Manifest().control,
            runtimeParameters: {
              ...baseV2Manifest().control.runtimeParameters,
              extraField: 'bad',
            },
          },
        }),
      ).toThrow(
        'Template manifest control.runtimeParameters contains unrecognized property extraField',
      );
    });

    it('accepts a file entry with an extra property the committed schema allows', () => {
      const valid = validate({
        ...baseV2Manifest(),
        files: [{ ...baseV2Manifest().files[0], role: 'entry' }],
      });
      expect(valid.files).toEqual([baseV2Manifest().files[0]]);
    });

    it('rejects a file entry the committed schema forbids', () => {
      const { sha256: _omitted, ...withoutDigest } = baseV2Manifest().files[0];
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...withoutDigest, role: 'entry' }],
        }),
      ).toThrow('Template manifest file at index 0 sha256 is invalid');
    });

    it('validates v2 files array structure and fields', () => {
      expect(() =>
        validate({ ...baseV2Manifest(), files: 'not-array' }),
      ).toThrow('Template manifest files must be an array');
      expect(() =>
        validate({ ...baseV2Manifest(), files: ['not-an-object'] }),
      ).toThrow('Template manifest file at index 0 must be an object');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], key: '   ' }],
        }),
      ).toThrow('Template manifest files[0].key is required');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], bytes: -1 }],
        }),
      ).toThrow('Template manifest file at index 0 bytes is invalid');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], bytes: 1.5 }],
        }),
      ).toThrow('Template manifest file at index 0 bytes is invalid');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], bytes: 'not-number' }],
        }),
      ).toThrow('Template manifest file at index 0 bytes is invalid');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], contentType: '  ' }],
        }),
      ).toThrow('Template manifest files[0].contentType is required');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], sha256: 'short' }],
        }),
      ).toThrow('Template manifest file at index 0 sha256 is invalid');
      expect(() =>
        validate({
          ...baseV2Manifest(),
          files: [{ ...baseV2Manifest().files[0], sha256: 12345 }],
        }),
      ).toThrow('Template manifest file at index 0 sha256 is invalid');
    });
  });
});

describe('isPublicNetworkAddress', () => {
  it.each([
    '0.1.2.3',
    '10.1.1.1',
    '127.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.0.1',
    '198.51.100.9',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'FD00::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:10.0.0.1',
    'not-an-address',
    '',
  ])('treats %p as non-public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '100.63.0.1',
    '100.128.0.1',
    '169.253.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.0.1.1',
    '192.169.0.1',
    '198.17.0.1',
    '198.20.0.1',
    '198.51.99.1',
    '198.51.101.1',
    '203.0.112.1',
    '203.0.114.1',
    '203.1.113.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '2001:db9::1',
    'fe7f::1',
  ])('treats %p as public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });
});

describe('readProgramTemplateManifest', () => {
  const stored = () => ({
    ...baseManifest(),
    entrypointUrl: 'https://cdn.fifthbell.com/t/index.html',
  });

  it('returns a stored manifest that has the persisted shape', () => {
    const value = stored();
    expect(readProgramTemplateManifest(value)).toBe(value);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['the wrong kind', { ...stored(), kind: 'x' }],
    ['the wrong contract version', { ...stored(), contractVersion: 3 }],
    ['a missing entrypointUrl', { ...stored(), entrypointUrl: 3 }],
    ['non-array capabilities', { ...stored(), capabilities: 'a' }],
    ['a missing control', { ...stored(), control: null }],
    ['non-array signals', withControlStored({ signals: 'x' })],
  ])('returns null for %s', (_label, value) => {
    expect(readProgramTemplateManifest(value)).toBeNull();
  });

  function withControlStored(control: Record<string, unknown>) {
    return {
      ...stored(),
      control: { ...baseManifest().control, ...control },
    };
  }
});

describe('program template projections', () => {
  const manifest = {
    ...baseManifest(),
    control: {
      ...baseManifest().control,
      signals: [...PROGRAM_TEMPLATE_SIGNALS],
    },
  } as unknown as ProgramTemplateManifest;
  const scene = {
    id: 1,
    name: 'Live',
    layoutId: 2,
    layout: { id: 2, name: 'L', componentType: 'c', settings: { a: 1 }, x: 9 },
    chyronText: 'Hello',
    metadata: { m: 1 },
    secret: 'drop',
  };
  const projectedScene = {
    id: 1,
    name: 'Live',
    layoutId: 2,
    layout: { id: 2, name: 'L', componentType: 'c', settings: { a: 1 } },
    chyronText: 'Hello',
    metadata: { m: 1 },
  };

  it('projects state with defaults for absent scenes and fade flag', () => {
    expect(
      projectProgramTemplateState(
        {
          id: 1,
          programId: 'p',
          activeScene: 'oops',
          stagedScene: { id: 3, layout: 'oops' },
          fadeToBlack: 'yes',
          updatedAt: 'now',
          version: 4,
          operator: 'drop',
        },
        manifest,
      ),
    ).toEqual({
      schemaVersion: 1,
      id: 1,
      programId: 'p',
      activeSceneId: null,
      activeScene: null,
      stagedSceneId: null,
      stagedScene: null,
      fadeToBlack: false,
      updatedAt: 'now',
      version: 4,
    });
  });

  it('projects scenes with null defaults and the fade flag when true', () => {
    const state = projectProgramTemplateState(
      {
        id: 1,
        programId: 'p',
        activeSceneId: 5,
        activeScene: { ...scene, chyronText: undefined, metadata: undefined },
        stagedSceneId: 6,
        stagedScene: scene,
        fadeToBlack: true,
      },
      manifest,
    );
    expect(state).toMatchObject({
      activeSceneId: 5,
      activeScene: { ...projectedScene, chyronText: null, metadata: null },
      stagedSceneId: 6,
      stagedScene: projectedScene,
      fadeToBlack: true,
    });
  });

  it('drops values that are not signal records, or not approved by the manifest', () => {
    expect(projectProgramTemplateSignal(null, manifest)).toBeNull();
    expect(projectProgramTemplateSignal({ type: 3 }, manifest)).toBeNull();
    expect(
      projectProgramTemplateSignal(
        { type: 'scene_change' },
        { ...manifest, control: { ...manifest.control, signals: [] } },
      ),
    ).toBeNull();
  });

  it.each([
    'scene_change',
    'program_scenes_changed',
    'program_media_groups_changed',
    'program_stingers_changed',
  ])('projects the state of %s and keeps its transition', (type) => {
    expect(
      projectProgramTemplateSignal(
        {
          type,
          programId: 'p',
          version: 9,
          transitionId: 't1',
          junk: 1,
          state: { id: 1, programId: 'p', version: 1, activeScene: scene },
        },
        manifest,
      ),
    ).toEqual({
      type,
      programId: 'p',
      schemaVersion: 1,
      version: 9,
      transitionId: 't1',
      state: expect.objectContaining({
        version: 9,
        activeScene: projectedScene,
        stagedScene: null,
      }),
    });
    expect(
      projectProgramTemplateSignal(
        { type, programId: 'p', version: 9, state: 'nope' },
        manifest,
      ),
    ).toBeNull();
  });

  it('omits an absent transition id', () => {
    const projected = projectProgramTemplateSignal(
      { type: 'scene_change', programId: 'p', version: 1, state: {} },
      manifest,
    );
    expect(projected).not.toHaveProperty('transitionId');
  });

  const payload = {
    settings: { s: 1 },
    updatedAt: 'u',
    sentAt: 'sent',
    instant: { i: 1 },
    triggeredAt: 't',
    playback: { p: 1 },
    sceneId: 3,
    instantId: 4,
    fadeMs: 50,
    loop: true,
    stagedSceneId: 8,
    secret: 'drop',
  };
  it.each([
    ['audio_bus_update', ['settings', 'updatedAt']],
    ['broadcast_settings_update', ['settings', 'updatedAt']],
    ['heartbeat', ['sentAt']],
    ['instant_play', ['instant', 'triggeredAt']],
    ['instant_stop_all', ['triggeredAt']],
    ['program_reload', ['triggeredAt']],
    ['scene_cleared', ['updatedAt']],
    ['scene_instant_state', ['playback']],
    ['scene_instant_stop', ['sceneId', 'instantId', 'triggeredAt', 'fadeMs']],
    ['scene_instant_take', ['sceneId', 'instant', 'loop', 'triggeredAt']],
    ['song_off_air', ['triggeredAt']],
  ])('copies only the approved fields of %s', (type, fields) => {
    const expected: Record<string, unknown> = {
      type,
      programId: 'p',
      schemaVersion: 1,
      version: 2,
    };
    for (const field of fields) {
      expected[field] = payload[field as keyof typeof payload];
    }
    expect(
      projectProgramTemplateSignal(
        { type, programId: 'p', version: 2, ...payload },
        manifest,
      ),
    ).toEqual(expected);
  });

  it.each(['scene_staged', 'scene_update'])(
    'projects the scene of %s',
    (type) => {
      const projected = projectProgramTemplateSignal(
        { type, programId: 'p', version: 2, ...payload, scene },
        manifest,
      );
      expect(projected).toMatchObject({ type, scene: projectedScene });
      expect(projected).not.toHaveProperty('secret');
      expect(
        projectProgramTemplateSignal(
          { type, programId: 'p', version: 2, scene: 'bad' },
          manifest,
        ),
      ).toMatchObject({ scene: null });
    },
  );

  it('forwards only the common fields for signals without a field table', () => {
    expect(
      projectProgramTemplateSignal(
        { type: 'program_state_snapshot', programId: 'p', version: 1, x: 1 },
        manifest,
      ),
    ).toEqual({
      type: 'program_state_snapshot',
      programId: 'p',
      schemaVersion: 1,
      version: 1,
    });
  });

  it('returns null for v2-only signals when manifest is contractVersion 1', () => {
    for (const signalType of V2_ONLY_SIGNALS) {
      expect(
        projectProgramTemplateSignal(
          { type: signalType, programId: 'p', version: 1 },
          {
            ...manifest,
            control: { ...manifest.control, signals: [signalType] },
          },
        ),
      ).toBeNull();
    }
  });

  it('projects the eight v2 signals with exactly their pinned fields for v2 manifest', () => {
    const v2Manifest: ProgramTemplateManifest = {
      kind: 'alcantara.program-template',
      contractVersion: 2,
      id: 'harbor-light.live-program',
      name: 'Harbor Light Live Program',
      package: '@harbor-light/template',
      bundleVersion: '1.0.0',
      schemaVersion: 2,
      entrypoint: 'index.html',
      entrypointUrl: 'https://template.harborlight.test/index.html',
      capabilities: ['audio.playback'],
      control: {
        protocol: 'alcantara.program.v2',
        transport: 'server-sent-events',
        snapshotPath: 'state',
        eventsPath: 'events',
        runtimeParameters: { programId: 'p', apiBaseUrl: 'u' },
        signals: Array.from(V2_ONLY_SIGNALS),
      },
    };

    // 1. chyron_update
    expect(
      projectProgramTemplateSignal(
        {
          type: 'chyron_update',
          programId: 'harbor-light-tv',
          version: 1,
          sceneId: 'scene-1',
          chyronText: 'Breaking News',
          dropped: 'extra',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'chyron_update',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      sceneId: 'scene-1',
      chyronText: 'Breaking News',
    });

    // 2. fade_to_black
    expect(
      projectProgramTemplateSignal(
        {
          type: 'fade_to_black',
          programId: 'harbor-light-tv',
          version: 1,
          active: true,
          dropped: 'extra',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'fade_to_black',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      active: true,
    });

    // 3. song_playback_active
    expect(
      projectProgramTemplateSignal(
        {
          type: 'song_playback_active',
          programId: 'harbor-light-tv',
          version: 1,
          songId: 's-1',
          title: 'Song Title',
          artist: 'Song Artist',
          coverUrl: 'https://cover.test/1.png',
          durationMs: 180000,
          startedAt: 1000,
          externalChartProvider: 'chart-1',
          externalChartRank: 1,
          externalChartSpins: 42,
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'song_playback_active',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      songId: 's-1',
      title: 'Song Title',
      artist: 'Song Artist',
      coverUrl: 'https://cover.test/1.png',
      durationMs: 180000,
      startedAt: 1000,
      externalChartProvider: 'chart-1',
      externalChartRank: 1,
      externalChartSpins: 42,
    });

    // 4. song_playback_update
    expect(
      projectProgramTemplateSignal(
        {
          type: 'song_playback_update',
          programId: 'harbor-light-tv',
          version: 1,
          songId: 's-1',
          positionMs: 5000,
          durationMs: 180000,
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'song_playback_update',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      songId: 's-1',
      positionMs: 5000,
      durationMs: 180000,
    });

    // 5. song_queue_update
    expect(
      projectProgramTemplateSignal(
        {
          type: 'song_queue_update',
          programId: 'harbor-light-tv',
          version: 1,
          items: [
            { songId: 's-1', title: 'T1', artist: 'A1', extra: 'drop' },
            'not-an-item',
            { songId: 's-2', title: 'T2', artist: 'A2' },
          ],
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'song_queue_update',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      items: [
        { songId: 's-1', title: 'T1', artist: 'A1' },
        { songId: 's-2', title: 'T2', artist: 'A2' },
      ],
    });
    expect(
      projectProgramTemplateSignal(
        {
          type: 'song_queue_update',
          programId: 'harbor-light-tv',
          version: 1,
          items: null,
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'song_queue_update',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
    });

    // 6. audio_levels
    expect(
      projectProgramTemplateSignal(
        {
          type: 'audio_levels',
          programId: 'harbor-light-tv',
          version: 1,
          rms: -14.2,
          peak: -1.0,
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'audio_levels',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      rms: -14.2,
      peak: -1.0,
    });

    // 7. audience_interaction_draw_start
    expect(
      projectProgramTemplateSignal(
        {
          type: 'audience_interaction_draw_start',
          programId: 'harbor-light-tv',
          version: 1,
          sceneId: 'sc-1',
          componentType: 'bracket',
          drawId: 'd-1',
          durationSeconds: 30,
          candidateIds: ['c1', 'c2'],
          slot: { matchId: 'm-1', field: 'f-1', extra: 'drop' },
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'audience_interaction_draw_start',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      sceneId: 'sc-1',
      componentType: 'bracket',
      drawId: 'd-1',
      durationSeconds: 30,
      candidateIds: ['c1', 'c2'],
      slot: { matchId: 'm-1', field: 'f-1' },
    });
    expect(
      projectProgramTemplateSignal(
        {
          type: 'audience_interaction_draw_start',
          programId: 'harbor-light-tv',
          version: 1,
          sceneId: 'sc-1',
          componentType: 'bracket',
          drawId: 'd-1',
          durationSeconds: 30,
          candidateIds: ['c1', 'c2'],
          slot: 'not-an-object',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'audience_interaction_draw_start',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      sceneId: 'sc-1',
      componentType: 'bracket',
      drawId: 'd-1',
      durationSeconds: 30,
      candidateIds: ['c1', 'c2'],
    });

    // 8. audience_interaction_draw_end
    expect(
      projectProgramTemplateSignal(
        {
          type: 'audience_interaction_draw_end',
          programId: 'harbor-light-tv',
          version: 1,
          sceneId: 'sc-1',
          componentType: 'bracket',
          drawId: 'd-1',
          selectedId: 'c1',
          untrusted: 'ignored',
        },
        v2Manifest,
      ),
    ).toEqual({
      type: 'audience_interaction_draw_end',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 1,
      sceneId: 'sc-1',
      componentType: 'bracket',
      drawId: 'd-1',
      selectedId: 'c1',
    });
  });
});

type Testable = ProgramTemplateService & {
  resolveHost: jest.Mock;
  fetchManifest: jest.Mock;
};

describe('ProgramTemplateService.inspect', () => {
  const originalEnv = process.env.NODE_ENV;
  const url = 'https://cdn.fifthbell.com/t/manifest.json';
  const json = (body: unknown = baseManifest(), init: ResponseInit = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  const build = (withMetrics = false) => {
    const metrics = { recordDependency: jest.fn() };
    const service = (
      withMetrics
        ? new ProgramTemplateService(metrics as never)
        : new ProgramTemplateService()
    ) as Testable;
    service.resolveHost = jest
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    service.fetchManifest = jest.fn();
    return { service, metrics };
  };
  const rejection = async (service: Testable, target = url) => {
    const error: unknown = await service.inspect(target).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  };

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it('registers the validated manifest and records a successful dependency call', async () => {
    const { service, metrics } = build(true);
    service.fetchManifest.mockResolvedValue(json());
    const result = await service.inspect(`  ${url}  `);
    expect(result.templateUrl).toBe(url);
    expect(result.templateVerifiedAt).toBeInstanceOf(Date);
    expect(result.templateManifest.entrypointUrl).toBe(
      'https://cdn.fifthbell.com/t/index.html',
    );
    expect(service.resolveHost).toHaveBeenCalledWith('cdn.fifthbell.com', {
      all: true,
      verbatim: true,
    });
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'program-template',
      'fetch',
      'success',
      expect.any(Number),
    );
  });

  it('works without a metrics collector, on success and failure', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(json());
    await expect(service.inspect(url)).resolves.toBeDefined();
    service.fetchManifest.mockRejectedValue(new Error('down'));
    await expect(service.inspect(url)).rejects.toThrow(BadRequestException);
  });

  it('records the failure and rethrows the original error', async () => {
    const { service, metrics } = build(true);
    service.fetchManifest.mockRejectedValue(new Error('network'));
    expect(await rejection(service)).toBe(
      'Template manifest could not be fetched',
    );
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'program-template',
      'fetch',
      'failure',
      expect.any(Number),
    );
  });

  it('sends a manual-redirect JSON request with a timeout signal', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(json());
    await service.inspect(url);
    const [target, init] = service.fetchManifest.mock.calls[0];
    expect((target as URL).toString()).toBe(url);
    expect(init).toMatchObject({
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows a relative redirect and revalidates the destination', async () => {
    const { service } = build();
    service.fetchManifest
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/v2/m.json' },
        }),
      )
      .mockResolvedValueOnce(json());
    const result = await service.inspect(url);
    expect(result.templateUrl).toBe('https://cdn.fifthbell.com/v2/m.json');
    expect(service.resolveHost).toHaveBeenCalledTimes(2);
    expect(result.templateManifest.entrypointUrl).toBe(
      'https://cdn.fifthbell.com/v2/index.html',
    );
  });

  it('rejects redirects without a location', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      new Response(null, { status: 301 }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest redirect could not be followed safely',
    );
  });

  it('gives up after three redirects', async () => {
    const { service } = build();
    service.fetchManifest.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: '/next.json' },
        }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest redirect could not be followed safely',
    );
    expect(service.fetchManifest).toHaveBeenCalledTimes(4);
  });

  it('rejects a redirect to a downgraded or private destination', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'http://cdn.fifthbell.com/m.json' },
      }),
    );
    expect(await rejection(service)).toBe(
      'Template URL must use HTTPS outside local development',
    );
    service.fetchManifest.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://10.0.0.1/m.json' },
      }),
    );
    expect(await rejection(service)).toBe(
      'Template URL must resolve to a public network address',
    );
  });

  it('rejects non-success statuses', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(json('{}', { status: 503 }));
    expect(await rejection(service)).toBe(
      'Template manifest returned HTTP 503',
    );
    service.fetchManifest.mockResolvedValue({
      status: 199,
      ok: false,
      headers: new Headers(),
      body: null,
    });
    expect(await rejection(service)).toBe(
      'Template manifest returned HTTP 199',
    );
  });

  it('requires a JSON content type', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest must use a JSON content type',
    );
    service.fetchManifest.mockResolvedValue(
      new Response('{}', { status: 200, headers: {} }),
    );
    // Headers.get on an absent content type yields null, treated as empty.
    service.fetchManifest.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
    });
    expect(await rejection(service)).toBe(
      'Template manifest must use a JSON content type',
    );
  });

  it('accepts +json content types with parameters', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      json(baseManifest(), {
        headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' },
      }),
    );
    await expect(service.inspect(url)).resolves.toBeDefined();
  });

  it('rejects a declared content length over the limit', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(256 * 1024 + 1),
      }),
      body: null,
    });
    expect(await rejection(service)).toBe('Template manifest is too large');
  });

  it('ignores an unparseable content length and bounds the body instead', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': 'abc',
      }),
      body: new Response(JSON.stringify(baseManifest())).body,
    });
    await expect(service.inspect(url)).resolves.toBeDefined();
  });

  it('reads manifests delivered in several chunks', async () => {
    const { service } = build();
    const text = JSON.stringify(baseManifest());
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, 20)));
        controller.enqueue(encoder.encode(text.slice(20)));
        controller.close();
      },
    });
    service.fetchManifest.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await service.inspect(url);
    expect(result.templateManifest.id).toBe('fifthbell.live-program');
  });

  it('cancels a stream whose chunks exceed the limit', async () => {
    const { service } = build();
    const cancel = jest.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel,
    });
    service.fetchManifest.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await rejection(service)).toBe('Template manifest is too large');
    expect(cancel).toHaveBeenCalled();
  });

  it('reports an unreadable body that is not a size violation', async () => {
    const { service } = build();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    service.fetchManifest.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest could not be read',
    );
  });

  it('treats a missing body as empty, invalid JSON', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest is not valid JSON',
    );
  });

  it('rejects text that is not JSON', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(json('{nope'));
    expect(await rejection(service)).toBe(
      'Template manifest is not valid JSON',
    );
  });

  it('propagates manifest validation failures', async () => {
    const { service } = build();
    service.fetchManifest.mockResolvedValue(
      json({ ...baseManifest(), kind: 'x' }),
    );
    expect(await rejection(service)).toBe(
      'Template manifest kind must be alcantara.program-template',
    );
  });

  describe('URL policy', () => {
    it.each([
      ['not a url', 'Template URL must be an absolute URL'],
      [
        'http://cdn.fifthbell.com/m.json',
        'Template URL must use HTTPS outside local development',
      ],
      [
        'http://localhost.evil.test/m.json',
        'Template URL must use HTTPS outside local development',
      ],
      [
        'ftp://cdn.fifthbell.com/m.json',
        'Template URL must use HTTPS outside local development',
      ],
      [
        'https://user:pw@cdn.fifthbell.com/m.json',
        'Template URL cannot contain credentials, query parameters, or a fragment',
      ],
      [
        'https://user@cdn.fifthbell.com/m.json',
        'Template URL cannot contain credentials, query parameters, or a fragment',
      ],
      [
        'https://cdn.fifthbell.com/m.json?x=1',
        'Template URL cannot contain credentials, query parameters, or a fragment',
      ],
      [
        'https://cdn.fifthbell.com/m.json#frag',
        'Template URL cannot contain credentials, query parameters, or a fragment',
      ],
      [
        'https://localhost/m.json',
        'Template URL must resolve to a public network address',
      ],
      [
        'https://printer.local/m.json',
        'Template URL must resolve to a public network address',
      ],
      [
        'https://192.168.0.5/m.json',
        'Template URL must resolve to a public network address',
      ],
    ])('rejects %s', async (target, message) => {
      const { service } = build();
      expect(await rejection(service, target)).toBe(message);
      expect(service.fetchManifest).not.toHaveBeenCalled();
    });

    it('allows plain http to localhost and 127.0.0.1 outside production without DNS', async () => {
      const { service } = build();
      service.fetchManifest.mockImplementation(async () => json());
      await expect(
        service.inspect('http://localhost:3000/m.json'),
      ).resolves.toMatchObject({ templateUrl: 'http://localhost:3000/m.json' });
      await expect(
        service.inspect('http://127.0.0.1:3000/m.json'),
      ).resolves.toMatchObject({ templateUrl: 'http://127.0.0.1:3000/m.json' });
      expect(service.resolveHost).not.toHaveBeenCalled();
    });

    it('does not allow local http in production', async () => {
      process.env.NODE_ENV = 'production';
      const { service } = build();
      expect(await rejection(service, 'http://localhost:3000/m.json')).toBe(
        'Template URL must use HTTPS outside local development',
      );
    });

    it('allows only the approved publisher in production', async () => {
      process.env.NODE_ENV = 'production';
      const { service } = build();
      expect(await rejection(service, 'https://other.example/m.json')).toBe(
        'Template URL origin is not an approved program-template publisher',
      );
      service.fetchManifest.mockResolvedValue(json());
      await expect(service.inspect(url)).resolves.toMatchObject({
        templateUrl: url,
      });

      // Test with custom fictional origin listed in PROGRAM_TEMPLATE_ORIGINS
      process.env.PROGRAM_TEMPLATE_ORIGINS =
        'https://template.harborlight.test';
      const fictionalUrl = 'https://template.harborlight.test/m.json';
      service.fetchManifest.mockResolvedValue(json(baseV2Manifest()));
      await expect(service.inspect(fictionalUrl)).resolves.toMatchObject({
        templateUrl: fictionalUrl,
        templateManifest: expect.objectContaining({ contractVersion: 2 }),
      });

      // Same fictional URL rejected when PROGRAM_TEMPLATE_ORIGINS is emptied
      delete process.env.PROGRAM_TEMPLATE_ORIGINS;
      expect(await rejection(service, fictionalUrl)).toBe(
        'Template URL origin is not an approved program-template publisher',
      );
    });

    describe('configured origin forms', () => {
      afterEach(() => {
        delete process.env.PROGRAM_TEMPLATE_ORIGINS;
      });

      it.each([
        ['a trailing slash', 'https://template.harborlight.test/'],
        ['an uppercase host', 'https://TEMPLATE.HarborLight.TEST'],
        ['an explicit :443', 'https://template.harborlight.test:443'],
      ])(
        'accepts a template from the matching origin when configured with %s',
        async (_label, configured) => {
          process.env.NODE_ENV = 'production';
          process.env.PROGRAM_TEMPLATE_ORIGINS = configured;
          const { service } = build();
          service.fetchManifest.mockResolvedValue(json(baseV2Manifest()));
          const target = 'https://template.harborlight.test/m.json';
          await expect(service.inspect(target)).resolves.toMatchObject({
            templateUrl: target,
            templateManifest: expect.objectContaining({ contractVersion: 2 }),
          });
          expect(
            await rejection(service, 'https://other.harborlight.test/m.json'),
          ).toBe(
            'Template URL origin is not an approved program-template publisher',
          );
        },
      );
    });

    it('getApprovedTemplateOrigins returns defaults and configured origins', () => {
      expect(getApprovedTemplateOrigins({})).toEqual(
        new Set(DEFAULT_PRODUCTION_TEMPLATE_ORIGINS),
      );
      expect(
        getApprovedTemplateOrigins({
          PROGRAM_TEMPLATE_ORIGINS: ' https://a.test , https://b.test ',
        }),
      ).toEqual(
        new Set([
          ...DEFAULT_PRODUCTION_TEMPLATE_ORIGINS,
          'https://a.test',
          'https://b.test',
        ]),
      );
    });

    it('fails when the host cannot be resolved', async () => {
      const { service } = build();
      service.resolveHost.mockRejectedValue(new Error('ENOTFOUND'));
      expect(await rejection(service)).toBe(
        'Template URL host could not be resolved',
      );
    });

    it('fails when DNS returns nothing or any non-public address', async () => {
      const { service } = build();
      service.resolveHost.mockResolvedValue([]);
      expect(await rejection(service)).toBe(
        'Template URL must resolve only to public network addresses',
      );
      service.resolveHost.mockResolvedValue([
        { address: '1.1.1.1' },
        { address: '10.0.0.1' },
      ]);
      expect(await rejection(service)).toBe(
        'Template URL must resolve only to public network addresses',
      );
      expect(service.fetchManifest).not.toHaveBeenCalled();
    });

    it('accepts a public literal IP without a DNS failure', async () => {
      const { service } = build();
      service.fetchManifest.mockResolvedValue(json());
      await expect(
        service.inspect('https://1.1.1.1/m.json'),
      ).resolves.toMatchObject({ templateUrl: 'https://1.1.1.1/m.json' });
    });
  });
});

describe('ProgramTemplateService dependency metadata', () => {
  it('declares the optional metrics collector as its injected dependency', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      ProgramTemplateService,
    );
    expect(paramTypes).toHaveLength(1);
    expect(paramTypes[0].name).toBe('ManagedMetricsService');
  });

  it('falls back to a generic dependency type when the metrics module has no export', () => {
    jest.isolateModules(() => {
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('./program-template.service') as {
        ProgramTemplateService: typeof ProgramTemplateService;
      };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          isolated.ProgramTemplateService,
        ),
      ).toEqual([Object]);
      expect(new isolated.ProgramTemplateService()).toBeInstanceOf(
        isolated.ProgramTemplateService,
      );
    });
    jest.dontMock('../observability/managed-metrics.service');
  });
});
