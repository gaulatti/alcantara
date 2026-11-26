import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { OutboundRefusal } from '../outbound/safe-fetch';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import {
  DestinationTestService,
  TEST_INTERVAL_MS,
  TEST_TIMEOUT_MS,
} from './destination-test.service';

// gaulatti/alcantara#384: the Test button reads the pinned key like the desktop studio (audited), probes the checked
// address, rate-limits per destination and never answers with the key.
const KEY = 'fictional-stream-key';

function build(row: unknown = { teamId: 7, retiredAt: null }) {
  const prisma = {
    broadcastDestination: { findUnique: jest.fn().mockResolvedValue(row) },
  };
  const ingest = {
    issue: jest.fn().mockResolvedValue({
      destinationId: 'd1',
      displayName: 'One',
      ingestUrl: 'rtmps://a.example.test:443/live2',
      streamKey: KEY,
    }),
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  const service = new DestinationTestService(
    prisma as never,
    ingest as never,
    metrics as never,
  );
  service.resolve = jest
    .fn()
    .mockResolvedValue({ address: '203.0.114.5', family: 4 });
  service.probe = jest.fn().mockResolvedValue({ result: 'accepted' });
  return { service, prisma, ingest, metrics };
}

describe('DestinationTestService', () => {
  it('probes the checked address with the pinned key, audited as the caller, and counts it', async () => {
    const f = build();
    await expect(f.service.test('d1', 'user-1', 7, 1000)).resolves.toEqual({
      result: 'accepted',
    });
    expect(f.ingest.issue).toHaveBeenCalledWith('d1', 'user-1', 7);
    expect(f.service.resolve).toHaveBeenCalledWith('a.example.test');
    expect(f.service.probe).toHaveBeenCalledWith(
      {
        scheme: 'rtmps',
        host: 'a.example.test',
        port: 443,
        application: 'live2',
        streamKey: KEY,
        address: '203.0.114.5',
      },
      TEST_TIMEOUT_MS,
    );
    expect(f.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'test',
      'succeeded',
    );
  });

  it('keeps a port, counts a refusal as failed', async () => {
    const f = build();
    f.ingest.issue.mockResolvedValue({
      ingestUrl: 'rtmp://a.example.test:1936/live',
      streamKey: KEY,
    });
    f.service.probe = jest
      .fn()
      .mockResolvedValue({ result: 'refused', message: 'no' });
    await f.service.test('d1', 'u', 0);
    expect(f.service.probe).toHaveBeenCalledWith(
      expect.objectContaining({ port: 1936, scheme: 'rtmp' }),
      TEST_TIMEOUT_MS,
    );
    expect(f.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'test',
      'failed',
    );
  });

  it('uses the scheme default when the address names no port', async () => {
    const f = build();
    f.ingest.issue.mockResolvedValue({
      ingestUrl: 'rtmp://a.example.test/live',
      streamKey: KEY,
    });
    await f.service.test('d1', 'u', 7);
    expect((f.service.probe as jest.Mock).mock.calls[0][0]).not.toHaveProperty(
      'port',
    );
  });

  it('allows one test per destination in the window, per destination', async () => {
    const f = build();
    await f.service.test('d1', 'u', 7, 1000);
    const again = await f.service
      .test('d1', 'u', 7, 1000 + TEST_INTERVAL_MS - 1)
      .catch((e) => e);
    expect(again).toBeInstanceOf(HttpException);
    expect(again.getStatus()).toBe(429);
    await f.service.test('d2', 'u', 7, 1001);
    await f.service.test('d1', 'u', 7, 1000 + TEST_INTERVAL_MS);
    expect(f.ingest.issue).toHaveBeenCalledTimes(3);
  });

  it('reads no key for an unknown, foreign or retired destination', async () => {
    for (const [row, kind] of [
      [null, NotFoundException],
      [{ teamId: 8, retiredAt: null }, NotFoundException],
      [{ teamId: 7, retiredAt: new Date() }, ConflictException],
    ] as const) {
      const f = build(row);
      await expect(f.service.test('d1', 'u', 7)).rejects.toBeInstanceOf(kind);
      expect(f.ingest.issue).not.toHaveBeenCalled();
    }
  });

  it('answers unreachable for a private or unknown host without connecting, and passes other errors on', async () => {
    for (const [reason, message] of [
      ['address', 'The ingest address is not a public address'],
      ['dns', 'The ingest host could not be found'],
    ] as const) {
      const f = build();
      f.service.resolve = jest
        .fn()
        .mockRejectedValue(new OutboundRefusal(reason));
      await expect(f.service.test('d1', 'u', 7)).resolves.toEqual({
        result: 'unreachable',
        message,
      });
      expect(f.service.probe).not.toHaveBeenCalled();
    }
    const f = build();
    f.service.probe = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(f.service.test('d1', 'u', 7)).rejects.toThrow('boom');
  });

  it('is reached from the controller with the caller and team', () => {
    const testing = { test: jest.fn().mockReturnValue('r') };
    const controller = new BroadcastDestinationsController(
      {} as never,
      {} as never,
      {} as never,
      testing as never,
    );
    expect(
      controller.testDestination('d1', {
        user: { sub: 'u', authorization: { teamId: 7 } },
      }),
    ).toBe('r');
    expect(testing.test).toHaveBeenCalledWith('d1', 'u', 7);
  });
});

describe('DestinationTestService decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('./broadcast-ingest.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- loaded with its dependencies mocked away */
      const loaded = require('./destination-test.service');
      expect(
        Reflect.getMetadata('design:paramtypes', loaded.DestinationTestService),
      ).toEqual([Object, Object, Object]);
      /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
    });
  });
});
