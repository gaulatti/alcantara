import { status } from '@grpc/grpc-js';
import {
  POMPEII_CHANNEL_RESET_INTERVAL_MS,
  PompeiiChannel,
} from './pompeii.service';

// gaulatti/alcantara#225: the channel is replaced after a timed-out or
// unavailable call, once per failed channel, at most once per interval.

type Callback = (error: unknown, value?: unknown) => void;

class FakeClient {
  calls: Callback[] = [];
  deadlines: Date[] = [];
  close = jest.fn();
  authorize = jest.fn(
    (_request: unknown, options: { deadline: Date }, callback: Callback) => {
      this.deadlines.push(options.deadline);
      this.calls.push(callback);
    },
  );
}

function failure(code: number) {
  return Object.assign(new Error(`code ${code}`), { code });
}

function setup(start = 1_000) {
  let clock = start;
  const clients: FakeClient[] = [];
  const resets: string[] = [];
  const channel = new PompeiiChannel(
    () => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    },
    (reason) => resets.push(reason),
    undefined,
    () => clock,
  );
  return {
    channel,
    clients,
    resets,
    advance: (ms: number) => (clock += ms),
  };
}

const request = { bearer_token: 't', permission: 'p', team_id: 0 };

describe('PompeiiChannel', () => {
  it('answers through the current channel with the deadline from its clock', async () => {
    const { channel, clients } = setup();
    const answer = channel.authorize(request, 2_000);
    expect(clients[0].deadlines[0].getTime()).toBe(3_000);
    clients[0].calls[0](null, { allowed: true });
    await expect(answer).resolves.toEqual({ allowed: true });
    const empty = channel.authorize(request, 2_000);
    clients[0].calls[1](null, undefined);
    await expect(empty).resolves.toEqual({});
    expect(channel.current).toBe(clients[0]);
  });

  it.each([
    [status.DEADLINE_EXCEEDED, 'deadline_exceeded'],
    [status.UNAVAILABLE, 'unavailable'],
  ])(
    'replaces the channel after code %s and still rejects',
    async (code, reason) => {
      const { channel, clients, resets } = setup();
      const answer = channel.authorize(request, 2_000);
      clients[0].calls[0](failure(code));
      await expect(answer).rejects.toMatchObject({ code });
      expect(clients).toHaveLength(2);
      expect(clients[0].close).toHaveBeenCalledTimes(1);
      expect(channel.current).toBe(clients[1]);
      expect(resets).toEqual([reason]);
    },
  );

  it.each([
    ['a permission error', failure(status.PERMISSION_DENIED)],
    ['an error without a code', new Error('socket hang up')],
  ])('keeps the channel after %s', async (_name, error) => {
    const { channel, clients, resets } = setup();
    const answer = channel.authorize(request, 2_000);
    clients[0].calls[0](error);
    await expect(answer).rejects.toBe(error);
    expect(clients).toHaveLength(1);
    expect(resets).toEqual([]);
  });

  it('replaces a channel once however many of its calls fail together', async () => {
    const { channel, clients, resets, advance } = setup();
    const answers = [
      channel.authorize(request, 2_000),
      channel.authorize(request, 2_000),
    ];
    clients[0].calls[0](failure(status.DEADLINE_EXCEEDED));
    advance(POMPEII_CHANNEL_RESET_INTERVAL_MS);
    clients[0].calls[1](failure(status.DEADLINE_EXCEEDED));
    await Promise.allSettled(answers);
    expect(clients).toHaveLength(2);
    expect(resets).toHaveLength(1);
  });

  it('replaces at most once per interval, so a slow Pompeii is not redialled on every call', async () => {
    const { channel, clients, resets, advance } = setup();
    const first = channel.authorize(request, 2_000);
    clients[0].calls[0](failure(status.DEADLINE_EXCEEDED));
    await first.catch(() => undefined);
    advance(POMPEII_CHANNEL_RESET_INTERVAL_MS - 1);
    const second = channel.authorize(request, 2_000);
    clients[1].calls[0](failure(status.DEADLINE_EXCEEDED));
    await expect(second).rejects.toMatchObject({ code: 4 });
    expect(clients).toHaveLength(2);
    advance(1);
    const third = channel.authorize(request, 2_000);
    clients[1].calls[1](failure(status.DEADLINE_EXCEEDED));
    await third.catch(() => undefined);
    expect(clients).toHaveLength(3);
    expect(resets).toEqual(['deadline_exceeded', 'deadline_exceeded']);
  });

  it('closes the current channel', () => {
    const { channel, clients } = setup();
    channel.close();
    expect(clients[0].close).toHaveBeenCalledTimes(1);
  });

  it('uses the real clock by default', async () => {
    const client = new FakeClient();
    const channel = new PompeiiChannel(
      () => client as never,
      () => undefined,
    );
    const before = Date.now();
    const answer = channel.authorize(request, 2_000);
    expect(client.deadlines[0].getTime()).toBeGreaterThanOrEqual(
      before + 2_000,
    );
    client.calls[0](null, {});
    await answer;
  });
});
