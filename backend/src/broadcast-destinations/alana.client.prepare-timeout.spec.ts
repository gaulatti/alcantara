import { AlanaClient, TELEVISION_PREPARE_TIMEOUT_MS } from './alana.client';

/** Preparing a television filler waits for a download and a transcode; every other call keeps its short bound. */
describe('Alana request bounds', () => {
  afterEach(() => jest.restoreAllMocks());

  function build() {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetched = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{}')));
    const client = new AlanaClient(
      {
        get: (key: string) =>
          ({
            ALANA_CONTROL_URL: 'http://alana.test',
            ALANA_CONTROL_TOKEN: 'a'.repeat(64),
          })[key],
      } as never,
      {
        observeDependency: jest.fn(),
        recordDependencyOperation: jest.fn(),
      } as never,
    );
    return { client, timeout, fetched };
  }

  it('gives a filler preparation fifteen minutes', async () => {
    const h = build();
    await h.client
      .prepareFiller('main', 'filler-tv-1', {} as never)
      .catch(() => undefined);
    expect(h.timeout).toHaveBeenCalledTimes(1);
    expect(h.timeout).toHaveBeenCalledWith(TELEVISION_PREPARE_TIMEOUT_MS);
    expect(h.fetched).toHaveBeenCalledTimes(1);
  });

  it('keeps ten seconds for the rest', async () => {
    const h = build();
    await h.client.liveProfile('main').catch(() => undefined);
    expect(h.timeout).toHaveBeenCalledWith(10_000);
  });
});
