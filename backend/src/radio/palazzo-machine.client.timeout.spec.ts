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
    (_url: string, init: { signal?: AbortSignal }) =>
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

  it('turns a command the engine never answers into unavailable when the timeout fires', async () => {
    const timeouts = controlledTimeouts();
    const { client, metrics } = build(frozenFetch());
    let settled = false;
    const outcome = client.stopSong(BASE, 'radio-1').then(
      () => null,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    // A song stop is retried: each attempt gets its own bounded wait, and the engine answers none of them.
    for (let attempt = 0; attempt < 10 && !settled; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!settled) timeouts.fire();
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(PalazzoMachineError);
    expect((error as PalazzoMachineError).reason).toBe('unavailable');
    expect(timeouts.spy).toHaveBeenCalledWith(PALAZZO_COMMAND_TIMEOUT_MS);
    expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
      'song-stop',
      'unavailable',
    );
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
