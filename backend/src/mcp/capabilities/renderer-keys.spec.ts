import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { callerWith } from './broadcast.testing';
import { specNamed } from './capabilities.testing';
import { RendererKeysMcpTools } from './renderer-keys';

const p = ALCANTARA_PERMISSIONS;
// A fictional key, built here: the rotation must never answer with it.
const ISSUED = 'alrk_fictional-key-built-in-this-test';
const NONE = {
  programId: 'station-a',
  exists: false,
  version: null,
  createdAt: null,
  rotatedAt: null,
  lastUsedAt: null,
};
const V3 = {
  ...NONE,
  exists: true,
  version: 3,
  createdAt: '2026-11-28T10:00:00.000Z',
  rotatedAt: '2026-11-28T11:00:00.000Z',
};
const V4 = { ...V3, version: 4, rotatedAt: '2026-11-28T12:00:00.000Z' };

function setup() {
  const keys = { metadata: jest.fn(), rotate: jest.fn() };
  const recorder = {
    actor: jest.fn(() => ({ kind: 'user', sub: 'fictional' })),
    record: jest.fn(async () => undefined),
  };
  const specs = new RendererKeysMcpTools(
    keys as never,
    recorder as never,
  ).specs();
  return { keys, recorder, specs };
}
const ctx = callerWith(p.program.read, p.program.manage);

describe('renderer key capabilities', () => {
  it('are a program.read read and a program.manage tier-A action, confirmed by program', async () => {
    const { specs, keys } = setup();
    expect(
      specs.map(({ name, permission, tier }) => ({ name, permission, tier })),
    ).toEqual([
      { name: 'webrtc_renderer_key', permission: p.program.read, tier: 'R' },
      {
        name: 'webrtc_rotate_renderer_key',
        permission: p.program.manage,
        tier: 'A',
      },
    ]);
    keys.metadata.mockResolvedValue(V3);
    await expect(
      specNamed(specs, 'webrtc_rotate_renderer_key').confirmTarget!(
        { program_id: 'station-a' },
        ctx,
      ),
    ).resolves.toEqual({ id: 'station-a', name: 'Renderer key' });
  });

  it("read the program's metadata", async () => {
    const { specs, keys } = setup();
    keys.metadata.mockResolvedValue(V3);
    const outcome = await specNamed(specs, 'webrtc_renderer_key').run(
      { program_id: 'station-a' },
      ctx,
    );
    expect(keys.metadata).toHaveBeenCalledWith('station-a');
    expect(JSON.stringify(outcome.result)).toContain('"version":3');
  });

  it('plan a first issue and a replacement, both as unrecoverable', async () => {
    const { specs, keys } = setup();
    const rotate = specNamed(specs, 'webrtc_rotate_renderer_key');
    keys.metadata.mockResolvedValueOnce(NONE);
    const first = await rotate.dryRun!({ program_id: 'station-a' }, ctx);
    expect(first.summary).toContain(
      'Issues the first renderer key of program station-a',
    );
    keys.metadata.mockResolvedValueOnce(V3);
    const next = await rotate.dryRun!({ program_id: 'station-a' }, ctx);
    expect(next.summary).toContain(
      'Replaces renderer key version 3 of program station-a',
    );
    expect(next).toMatchObject({
      affects: [{ kind: 'program', id: 'station-a', name: 'Renderer key' }],
      recoverable: false,
      onAir: true,
    });
    expect(keys.rotate).not.toHaveBeenCalled();
  });

  it('rotate, record the change with the version only, and answer without the key', async () => {
    const { specs, keys, recorder } = setup();
    keys.metadata.mockResolvedValue(V3);
    keys.rotate.mockResolvedValue({
      key: ISSUED,
      metadata: V4,
      previousVersion: 3,
    });
    const outcome = await specNamed(specs, 'webrtc_rotate_renderer_key').run(
      { program_id: 'station-a' },
      ctx,
    );
    expect(keys.rotate).toHaveBeenCalledWith('station-a');
    expect(outcome.audit).toEqual({ target: 'station-a' });
    expect(JSON.stringify(outcome.result)).toContain('"version":4');
    expect(JSON.stringify(outcome.result)).not.toContain(ISSUED);
    expect(JSON.stringify(outcome.result)).not.toContain('"key"');
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', sub: 'fictional' },
        target: 'program',
        targetId: 'station-a',
        programId: 'station-a',
        capability: {
          mcp: 'webrtc_rotate_renderer_key',
          console: 'program.rotate-renderer-key',
        },
      }),
    );
    expect(JSON.stringify(recorder.record.mock.calls)).not.toContain(ISSUED);
  });
});

describe('RendererKeysMcpTools decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../../renderer-keys/renderer-key.service', () => ({
        RendererKeyService: undefined,
      }));
      jest.doMock('../../operator-change/operator-change-recorder', () => ({
        ...jest.requireActual('../../operator-change/operator-change-recorder'),
        OperatorChangeRecorder: undefined,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RendererKeysMcpTools: Isolated } = require('./renderer-keys') as {
        RendererKeysMcpTools: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
      ]);
    });
  });
});
