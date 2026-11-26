/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the in-memory store and Alana doubles are untyped */
import { BadGatewayException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { BroadcastDestinationsService } from '../broadcast-destinations/broadcast-destinations.service';
import { canonicalJson } from '../broadcast-destinations/broadcast-destinations.types';
import { FillerBindingService } from './filler-binding.service';

// gaulatti/alcantara#126: a television Start binds to the program's prepared
// filler version, and a program without one starts exactly as before.

const CHECKSUM = 'e'.repeat(64);
const PAYLOAD = {
  version: 'destinations-test-version',
  destinations: [
    {
      id: 'primary',
      secretId: 'broadcast/test/primary',
      versionId: 'version-1',
    },
  ],
};
const SELECTION_ACK = {
  version: PAYLOAD.version,
  selectionHash: createHash('sha256')
    .update(canonicalJson(PAYLOAD))
    .digest('hex'),
  count: 1,
  destinationIds: ['primary'],
};

function status(overrides: Record<string, unknown> = {}): any {
  return {
    requestedState: 'stopped',
    actualState: 'stopped',
    transition: null,
    readiness: false,
    lastSequence: 4,
    activeDestinations: null,
    pendingDestinations: null,
    destinations: [],
    commandResult: null,
    ...overrides,
  };
}
const executorFiller = (overrides: Record<string, unknown> = {}) => ({
  version: 'filler-tv-1',
  status: 'ready',
  ready: true,
  sourceId: 'slate',
  sourceSha256: 'd'.repeat(64),
  profileChecksum: CHECKSUM,
  ...overrides,
});

/** Filler rows plus the broadcast command rows a Start writes. */
function store(
  leg: {
    pendingVersionId?: string | null;
    activeVersionId?: string | null;
  } | null,
) {
  const versions = new Map<string, any>([
    [
      'filler-tv-1',
      { id: 'filler-tv-1', config: { profileChecksum: CHECKSUM } },
    ],
    [
      'filler-tv-0',
      { id: 'filler-tv-0', config: { profileChecksum: CHECKSUM } },
    ],
  ]);
  let televisionLeg = leg
    ? { pendingVersionId: null, activeVersionId: null, ...leg }
    : null;
  let command: any;
  const selection = {
    id: 'selection-1',
    version: PAYLOAD.version,
    programId: 'main',
    selectionHash: SELECTION_ACK.selectionHash,
    destinations: [
      {
        destinationId: 'primary',
        displayName: 'Primary',
        secretId: 'broadcast/test/primary',
        secretVersionId: 'version-1',
        position: 0,
      },
    ],
  };
  const prisma: any = {
    fillerLeg: {
      findUnique: jest.fn(() => Promise.resolve(televisionLeg)),
      updateMany: jest.fn(({ where, data }: any) => {
        const matches =
          televisionLeg !== null &&
          (where.pendingVersionId === undefined ||
            televisionLeg.pendingVersionId === where.pendingVersionId);
        if (matches) televisionLeg = { ...televisionLeg!, ...data };
        return Promise.resolve({ count: matches ? 1 : 0 });
      }),
    },
    fillerVersion: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(versions.get(where.id) ?? null),
      ),
    },
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ programId: 'main', type: 'tv' }),
    },
    broadcastDestination: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'primary',
          displayName: 'Primary',
          secretId: 'broadcast/test/primary',
          secretVersionId: 'version-1',
          position: 0,
          retiredAt: null,
        },
      ]),
    },
    broadcastDestinationSelection: {
      create: jest.fn().mockResolvedValue(selection),
    },
    broadcastDestinationCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: any) => {
        command = { ...data, selection, downstreamStatus: null };
        return Promise.resolve(command);
      }),
      update: jest.fn(({ data }: any) => {
        command = { ...command, ...data };
        return Promise.resolve(command);
      }),
    },
    broadcastDestinationRuntime: {
      upsert: jest.fn().mockResolvedValue({ nextSequence: 5 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((run: (tx: unknown) => Promise<unknown>) =>
      run(prisma),
    ),
  };
  return { prisma, leg: () => televisionLeg, command: () => command };
}

function build(leg: Parameters<typeof store>[0], lifecycle: any, started: any) {
  const db = store(leg);
  const metrics = new ManagedMetricsService();
  const binding = new FillerBindingService(db.prisma, metrics);
  const alana = {
    status: jest.fn().mockResolvedValue(lifecycle),
    reload: jest
      .fn()
      .mockResolvedValue(
        status({ ...lifecycle, pendingDestinations: SELECTION_ACK }),
      ),
    start: jest.fn().mockResolvedValue(started),
  };
  const service = new BroadcastDestinationsService(
    db.prisma,
    alana as never,
    metrics,
    binding,
    { cancelDeletion: jest.fn(), scheduleDeletion: jest.fn() } as never,
  );
  const bindings = async () =>
    (await metrics.render(''))
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('alcantara_filler_start_bindings_total{') &&
          !line.endsWith(' 0'),
      );
  const start = () =>
    service.start(
      'main',
      { commandId: 'command-1', destinationIds: ['primary'], confirmed: true },
      'operator',
    );
  return { ...db, binding, alana, start, bindings, metrics, service };
}

const running = (overrides: Record<string, unknown> = {}) =>
  status({
    requestedState: 'running',
    actualState: 'running',
    activeDestinations: SELECTION_ACK,
    ...overrides,
  });

describe('television Start filler binding', () => {
  it('starts exactly as before when the program has no filler', async () => {
    const h = build(
      null,
      status({ pendingFiller: executorFiller() }),
      running(),
    );
    await expect(h.start()).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.alana.start).toHaveBeenCalledTimes(1);
    expect(h.prisma.fillerLeg.updateMany).not.toHaveBeenCalled();
    expect(await h.bindings()).toEqual([
      'alcantara_filler_start_bindings_total{result="not-configured"} 1',
    ]);
  });

  it('starts exactly as before with an Alana that acknowledges no profile checksum', async () => {
    const h = build(
      { pendingVersionId: 'filler-tv-1' },
      status({ pendingFiller: executorFiller({ profileChecksum: undefined }) }),
      running(),
    );
    await expect(h.start()).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.leg()).toMatchObject({
      pendingVersionId: 'filler-tv-1',
      activeVersionId: null,
    });
    expect(await h.bindings()).toEqual([
      'alcantara_filler_start_bindings_total{result="legacy-executor"} 1',
    ]);
  });

  it('binds the pending version and makes it the active one', async () => {
    const h = build(
      { pendingVersionId: 'filler-tv-1', activeVersionId: 'filler-tv-0' },
      status({
        pendingFiller: executorFiller(),
        activeFiller: executorFiller({ version: 'filler-tv-0' }),
      }),
      running({ activeFiller: executorFiller() }),
    );
    await expect(h.start()).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.leg()).toEqual({
      pendingVersionId: null,
      activeVersionId: 'filler-tv-1',
    });
    expect(await h.bindings()).toEqual([
      'alcantara_filler_start_bindings_total{result="bound"} 1',
    ]);
  });

  it('binds the active version again when nothing is pending', async () => {
    const h = build(
      { activeVersionId: 'filler-tv-1' },
      status({ activeFiller: executorFiller() }),
      running({ activeFiller: executorFiller() }),
    );
    await expect(h.start()).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.leg()).toEqual({
      pendingVersionId: null,
      activeVersionId: 'filler-tv-1',
    });
  });

  it.each([
    ['another version', executorFiller({ version: 'filler-tv-9' })],
    ['a version that is not ready', executorFiller({ ready: false })],
    [
      'a different profile checksum',
      executorFiller({ profileChecksum: 'f'.repeat(64) }),
    ],
  ])(
    'refuses Start, sending nothing, when Alana holds %s',
    async (_name, held) => {
      const h = build(
        { pendingVersionId: 'filler-tv-1' },
        status({ pendingFiller: held }),
        running(),
      );
      await expect(h.start()).rejects.toThrow(
        new ConflictException(
          'Alana is not prepared with the program television filler',
        ),
      );
      expect(h.alana.reload).not.toHaveBeenCalled();
      expect(h.alana.start).not.toHaveBeenCalled();
      expect(h.command()).toMatchObject({ status: 'failed' });
      expect(h.leg()).toMatchObject({
        pendingVersionId: 'filler-tv-1',
        activeVersionId: null,
      });
      expect(await h.bindings()).toEqual([
        'alcantara_filler_start_bindings_total{result="mismatch"} 1',
      ]);
    },
  );

  it('reports a failed binding when the started session runs another filler', async () => {
    const h = build(
      { pendingVersionId: 'filler-tv-1' },
      status({ pendingFiller: executorFiller() }),
      running({ activeFiller: executorFiller({ version: 'filler-tv-0' }) }),
    );
    await expect(h.start()).rejects.toThrow(BadGatewayException);
    expect(h.alana.start).toHaveBeenCalledTimes(1);
    expect(h.command()).toMatchObject({ status: 'failed' });
    expect(h.leg()).toMatchObject({
      pendingVersionId: 'filler-tv-1',
      activeVersionId: null,
    });
    expect(await h.bindings()).toEqual([
      'alcantara_filler_start_bindings_total{result="mismatch"} 1',
    ]);
  });

  it('treats a pointer to a missing version as no filler', async () => {
    const h = build(
      { pendingVersionId: 'filler-tv-gone' },
      status({ pendingFiller: executorFiller() }),
      running(),
    );
    await expect(
      h.binding.televisionStartBinding('main', status()),
    ).resolves.toBeNull();
  });

  it.each([
    [null, 'filler-tv-1'],
    ['filler-tv-0', 'filler-tv-0'],
  ])(
    'binds after Stop the filler a Start would bind without it (pending %s)',
    async (pending, bound) => {
      const leg = { pendingVersionId: pending, activeVersionId: 'filler-tv-1' };
      const executor = status({
        activeFiller: executorFiller({ version: bound }),
      });
      const without = build({ ...leg }, status(), running());
      await expect(
        without.binding.televisionStartBinding('main', executor),
      ).resolves.toMatchObject({ id: bound });

      const h = build({ ...leg }, status(), running());
      (h.alana as unknown as { stop: jest.Mock }).stop = jest
        .fn()
        .mockResolvedValue(status());
      await h.service.stop(
        'main',
        { commandId: 'command-1', confirmed: true },
        'operator',
      );
      expect(h.leg()).toEqual({
        pendingVersionId: bound,
        activeVersionId: null,
      });
      await expect(
        h.binding.televisionStartBinding('main', executor),
      ).resolves.toMatchObject({ id: bound });
    },
  );

  it('stops television even when the release write fails, and counts it', async () => {
    const h = build({ activeVersionId: 'filler-tv-1' }, status(), running());
    (h.alana as unknown as { stop: jest.Mock }).stop = jest
      .fn()
      .mockResolvedValue(status());
    h.prisma.fillerLeg.updateMany.mockRejectedValueOnce(new Error('down'));
    await expect(
      h.service.stop(
        'main',
        { commandId: 'command-1', confirmed: true },
        'operator',
      ),
    ).resolves.toBeDefined();
    expect(h.command()).toMatchObject({ status: 'succeeded' });
    expect(await h.metrics.render('')).toContain(
      'alcantara_filler_releases_total{leg="television",result="failed"} 1',
    );
  });

  it('exposes all four binding results from the first scrape', async () => {
    const lines = (await new ManagedMetricsService().render(''))
      .split('\n')
      .filter((line) =>
        line.startsWith('alcantara_filler_start_bindings_total{'),
      );
    expect(lines.sort()).toEqual(
      ['bound', 'legacy-executor', 'mismatch', 'not-configured'].map(
        (result) =>
          `alcantara_filler_start_bindings_total{result="${result}"} 0`,
      ),
    );
  });
});
