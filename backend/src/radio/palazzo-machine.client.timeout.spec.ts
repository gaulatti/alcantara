import {
  PALAZZO_COMMAND_TIMEOUT_MS,
  PalazzoMachineClient,
  PalazzoMachineError,
} from './palazzo-machine.client';

// gaulatti/alcantara#717: every Palazzo command is bounded, so a frozen engine (connections accepted, no answers)
// turns into "unavailable" after PALAZZO_COMMAND_TIMEOUT_MS instead of holding the desk. The event stream is
// long-lived and is not bounded; a caller's own abort still wins.

jest.mock('node:timers/promises', () => ({
  setTimeout: () => Promise.resolve(),
}));

const BASE = 'http://palazzo:3100';

/** A fetch that never answers: it settles only when its signal aborts, as a frozen engine would. */
const frozenFetch = () =>
  jest.fn(
    (_url: string, init: { method?: string; signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      }),
  );

function build(fetchImpl: jest.Mock) {
  const config = {
    get: (key: string) =>
      ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE })[key],
  };
  const metrics = {
    recordMachineRequest: jest.fn(),
    recordMachineRetry: jest.fn(),
  };
  const client = new PalazzoMachineClient(
    config as never,
    metrics as never,
    fetchImpl as never,
  );
  return { client, metrics };
}

/** Replaces AbortSignal.timeout with signals the test fires. */
function controlledTimeouts() {
  const controllers: AbortController[] = [];
  const spy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  return {
    spy,
    fire: () =>
      controllers.at(-1)?.abort(new DOMException('timed out', 'TimeoutError')),
  };
}

afterEach(() => jest.restoreAllMocks());

describe('PalazzoMachineClient request timeout', () => {
  it('bounds each command at ten seconds', () => {
    expect(PALAZZO_COMMAND_TIMEOUT_MS).toBe(10_000);
  });

  /** Runs a command against a frozen engine, firing each attempt's timeout, and records every attempt. */
  async function runFrozen(
    command: (client: PalazzoMachineClient) => Promise<unknown>,
  ) {
    const timeouts = controlledTimeouts();
    const fetchImpl = frozenFetch();
    const { client, metrics } = build(fetchImpl);
    let settled = false;
    const outcome = command(client).then(
      () => null,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    for (let attempt = 0; attempt < 10 && !settled; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!settled) timeouts.fire();
    }
    const error = await outcome;
    const attempts = fetchImpl.mock.calls.map(
      ([url, init]: [string, { method?: string }]) =>
        `${init.method ?? 'GET'} ${url.replace(`${BASE}/v1/programs/radio-1`, '')}`,
    );
    return { error, attempts, timeouts, metrics };
  }

  it('fails a song stop after its first timeout and never sends it twice', async () => {
    const { error, attempts, timeouts, metrics } = await runFrozen((client) =>
      client.stopSong(BASE, 'radio-1'),
    );
    expect(error).toBeInstanceOf(PalazzoMachineError);
    expect((error as PalazzoMachineError).reason).toBe('unavailable');
    // One attempt only: a late first stop plus a retry could stop the next song.
    expect(attempts).toEqual(['POST /playback/song/stop']);
    expect(timeouts.spy.mock.calls).toEqual([[PALAZZO_COMMAND_TIMEOUT_MS]]);
    expect(metrics.recordMachineRetry).not.toHaveBeenCalled();
    expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
      'song-stop',
      'unavailable',
    );
  });

  it.each([
    [
      'an instant stop',
      (c: PalazzoMachineClient) => c.stopInstants(BASE, 'radio-1'),
      'POST /playback/instant/stop',
    ],
    [
      'a next withdrawal',
      (c: PalazzoMachineClient) => c.withdrawNext(BASE, 'radio-1'),
      'DELETE /playback/next',
    ],
  ])('does not resend %s after a timeout', async (_name, command, attempt) => {
    const { error, attempts, metrics } = await runFrozen(command);
    expect((error as PalazzoMachineError).reason).toBe('unavailable');
    expect(attempts).toEqual([attempt]);
    expect(metrics.recordMachineRetry).not.toHaveBeenCalled();
  });

  it('retries a read after each timeout, every attempt bounded', async () => {
    const { error, attempts, timeouts, metrics } = await runFrozen((client) =>
      client.getMixer(BASE, 'radio-1'),
    );
    expect((error as PalazzoMachineError).reason).toBe('unavailable');
    expect(attempts).toEqual(['GET /mixer', 'GET /mixer', 'GET /mixer']);
    expect(timeouts.spy).toHaveBeenCalledTimes(3);
    expect(metrics.recordMachineRetry).toHaveBeenCalledTimes(2);
  });

  it('still retries a song stop the engine refused with a server error', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { client, metrics } = build(fetchImpl);
    await client.stopSong(BASE, 'radio-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(metrics.recordMachineRetry).toHaveBeenCalledWith('song-stop');
  });

  it('does not bound the long-lived event stream', async () => {
    const timeouts = controlledTimeouts();
    const fetchImpl = jest.fn(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const { client } = build(fetchImpl);
    await client.connectEvents(
      BASE,
      'radio-1',
      null,
      new AbortController().signal,
    );
    expect(timeouts.spy).not.toHaveBeenCalled();
  });

  it('still rethrows the caller abort when the caller cancels first', async () => {
    controlledTimeouts();
    const caller = new AbortController();
    const { client } = build(frozenFetch());
    const reading = client.getPlaybackState(BASE, 'radio-1', caller.signal);
    await Promise.resolve();
    caller.abort(new Error('caller gave up'));
    await expect(reading).rejects.toThrow('caller gave up');
  });
});
