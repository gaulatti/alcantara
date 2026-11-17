import { unsafeAddress } from './address-policy';
import { isAudioMediaType } from './media-types';
import {
  OUTBOUND_REFUSAL_MESSAGES,
  OutboundRefusal,
  checkedAddress,
  defaultRequest,
  defaultResolve,
  pinnedLookup,
  safeFetch,
  type OutboundFetchResult,
  type SafeFetchOptions,
} from './safe-fetch';
import { scriptedTransport } from './safe-fetch.testing';

describe('outbound-request policy', () => {
  const audio = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    path: 'program_audio',
    maxBytes: 1024,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowContentType: isAudioMediaType,
    ...extra,
  });
  const ok = {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'set-cookie': 'secret=1' },
    body: Buffer.from('ID3fake'),
  };
  const names = {
    'media.example.com': ['93.184.216.34'],
    'cdn.example.com': ['2606:2800:220:1:248:1893:25c8:1946'],
    'inside.example.com': ['10.1.2.3'],
    'mixed.example.com': ['93.184.216.34', '192.168.1.10'],
  };

  const refusal = async (
    url: string,
    script: Parameters<typeof scriptedTransport>[1],
    options: Partial<SafeFetchOptions> = {},
  ) => {
    const transport = scriptedTransport(names, script);
    const recorded: OutboundFetchResult[] = [];
    const error = await safeFetch(url, audio(options), {
      ...transport,
      record: (_path, result) => recorded.push(result),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OutboundRefusal);
    return {
      reason: (error as OutboundRefusal).reason,
      message: (error as OutboundRefusal).message,
      recorded,
      sent: transport.sent,
    };
  };

  it('fetches a public https audio file, connecting to the checked address with SNI and Host kept', async () => {
    const transport = scriptedTransport(names, {
      'media.example.com/a.mp3': ok,
    });
    const recorded: OutboundFetchResult[] = [];
    const response = await safeFetch(
      'https://media.example.com/a.mp3',
      audio({ headers: {} }),
      { ...transport, record: (_p, r) => recorded.push(r) },
    );
    expect(response.body.toString()).toBe('ID3fake');
    expect(response.contentType).toBe('audio/mpeg');
    expect(response.contentLength).toBe(7);
    expect(recorded).toEqual(['ok']);
    expect(transport.sent).toEqual([
      {
        scheme: 'https:',
        hostname: 'media.example.com',
        path: '/a.mp3',
        method: 'GET',
        headers: { host: 'media.example.com' },
        servername: 'media.example.com',
        connectedTo: '93.184.216.34',
      },
    ]);
  });

  it('accepts a public IPv6 host and a redirect to another public host', async () => {
    const response = await safeFetch(
      'https://media.example.com/old.mp3',
      audio(),
      scriptedTransport(names, {
        'media.example.com/old.mp3': {
          status: 302,
          headers: { location: 'https://cdn.example.com/new.mp3' },
        },
        'cdn.example.com/new.mp3': ok,
      }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ['plain http', 'http://media.example.com/a.mp3', 'scheme'],
    ['another scheme', 'ftp://media.example.com/a.mp3', 'scheme'],
    ['a non-URL', 'not a url', 'invalid_url'],
    [
      'credentials in the URL',
      'https://u:p@media.example.com/a',
      'invalid_url',
    ],
    ['a private IPv4 literal', 'https://10.0.0.7/a.mp3', 'address'],
    ['a 192.168 literal', 'https://192.168.0.1/a.mp3', 'address'],
    ['a 172.16 literal', 'https://172.16.5.4/a.mp3', 'address'],
    ['a loopback IPv4 literal', 'https://127.0.0.1/a.mp3', 'address'],
    ['a loopback IPv6 literal', 'https://[::1]/a.mp3', 'address'],
    ['a private IPv6 literal', 'https://[fd12:3456::1]/a.mp3', 'address'],
    [
      'an IPv4-mapped private literal',
      'https://[::ffff:10.0.0.1]/a',
      'address',
    ],
    ['a link-local IPv4 literal', 'https://169.254.10.20/a.mp3', 'address'],
    ['a link-local IPv6 literal', 'https://[fe80::1]/a.mp3', 'address'],
    ['the metadata address', 'https://169.254.169.254/latest/', 'address'],
    ['the unspecified address', 'https://0.0.0.0/a.mp3', 'address'],
    [
      'a name that resolves to a private address',
      'https://inside.example.com/a',
      'address',
    ],
    [
      'a name with any private address among its answers',
      'https://mixed.example.com/a',
      'address',
    ],
    ['a name that does not resolve', 'https://nowhere.example.com/a', 'dns'],
  ])('refuses %s before connecting', async (_label, url, reason) => {
    const result = await refusal(url, {});
    expect(result.reason).toBe(reason);
    expect(result.sent).toEqual([]);
    expect(result.recorded).toEqual([reason]);
    expect(result.message).not.toContain('example.com');
  });

  it('refuses a public host that redirects to a private one, without connecting to it', async () => {
    const result = await refusal('https://media.example.com/a.mp3', {
      'media.example.com/a.mp3': {
        status: 301,
        headers: { location: 'https://inside.example.com/secret' },
      },
    });
    expect(result.reason).toBe('address');
    expect(result.sent.map((s) => s.hostname)).toEqual(['media.example.com']);
  });

  it('refuses a redirect to plain http and to a literal private address', async () => {
    for (const location of [
      'http://media.example.com/b.mp3',
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      const result = await refusal('https://media.example.com/a.mp3', {
        'media.example.com/a.mp3': { status: 302, headers: { location } },
      });
      expect(['scheme', 'address']).toContain(result.reason);
      expect(result.sent).toHaveLength(1);
    }
  });

  it('refuses too many redirects', async () => {
    const result = await refusal('https://media.example.com/0', {
      'media.example.com/0': { status: 302, headers: { location: '/1' } },
      'media.example.com/1': { status: 302, headers: { location: '/2' } },
      'media.example.com/2': { status: 302, headers: { location: '/3' } },
      'media.example.com/3': ok,
    });
    expect(result.reason).toBe('redirects');
    expect(result.sent).toHaveLength(3);
  });

  it('refuses an oversized body, declared or streamed', async () => {
    expect(
      (
        await refusal('https://media.example.com/big', {
          'media.example.com/big': {
            ...ok,
            headers: { 'content-type': 'audio/mpeg', 'content-length': '4096' },
          },
        })
      ).reason,
    ).toBe('too_large');
    expect(
      (
        await refusal('https://media.example.com/stream', {
          'media.example.com/stream': {
            ...ok,
            body: [Buffer.alloc(600), Buffer.alloc(600)],
          },
        })
      ).reason,
    ).toBe('too_large');
  });

  it('refuses a host that does not answer in time', async () => {
    const result = await refusal(
      'https://media.example.com/slow',
      { 'media.example.com/slow': { status: 200, hang: true } },
      { timeoutMs: 50 },
    );
    expect(result.reason).toBe('timeout');
  });

  it.each([
    ['text/html', 'text/html; charset=utf-8'],
    ['an image', 'image/png'],
    ['a missing type', undefined],
  ])('refuses a wrong content type: %s', async (_label, type) => {
    const result = await refusal('https://media.example.com/a', {
      'media.example.com/a': {
        status: 200,
        headers: type ? { 'content-type': type } : {},
        body: Buffer.from('x'),
      },
    });
    expect(result.reason).toBe('content_type');
  });

  it('reports an upstream error status', async () => {
    const result = await refusal('https://media.example.com/gone', {
      'media.example.com/gone': { status: 404 },
    });
    expect(result.reason).toBe('http_status');
  });

  it('has a plain message for every refusal, never a URL', () => {
    for (const message of Object.values(OUTBOUND_REFUSAL_MESSAGES))
      expect(message).not.toMatch(/https?:|\.com|\d+\.\d+\.\d+\.\d+/);
  });
});

describe('outbound-request policy, other outcomes', () => {
  const base: SafeFetchOptions = {
    path: 'now_playing',
    maxBytes: 1024,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowContentType: isAudioMediaType,
  };
  const names = {
    'hook.example.com': ['93.184.216.34'],
    'empty.example.com': [],
  };
  const reason = (promise: Promise<unknown>) =>
    promise.then(
      () => 'fetched',
      (error: OutboundRefusal) => error.reason,
    );

  it('fetches a public IP literal directly, without SNI', async () => {
    const transport = scriptedTransport(names, {
      '93.184.216.34/a.mp3': {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
        body: Buffer.from('a'),
      },
    });
    await safeFetch('https://93.184.216.34/a.mp3', base, transport);
    expect(transport.sent[0]).toMatchObject({
      connectedTo: '93.184.216.34',
      servername: undefined,
    });
  });

  it('posts a body without reading the answer, and reports a recorded http consumer', async () => {
    const transport = scriptedTransport(names, {
      'hook.example.com/in': { status: 204 },
    });
    const recorded: string[] = [];
    const response = await safeFetch(
      'http://hook.example.com/in',
      {
        ...base,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
        readBody: false,
        allowLegacyHttp: true,
      },
      { ...transport, record: (_p, r) => recorded.push(r) },
    );
    expect(response).toMatchObject({
      status: 204,
      contentType: '',
      contentLength: null,
      legacyHttp: true,
    });
    expect(recorded).toEqual(['legacy_http']);
    expect(transport.sent[0]).toMatchObject({
      scheme: 'http:',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': 7,
        host: 'hook.example.com',
      },
    });
  });

  it('never follows a redirect to plain http, even for a recorded http consumer', async () => {
    const transport = scriptedTransport(names, {
      'hook.example.com/in': {
        status: 307,
        headers: { location: 'http://hook.example.com/other' },
      },
    });
    expect(
      await reason(
        safeFetch(
          'http://hook.example.com/in',
          { ...base, readBody: false, allowLegacyHttp: true },
          transport,
        ),
      ),
    ).toBe('scheme');
  });

  it('reads the media type from a repeated header', async () => {
    const transport = scriptedTransport(names, {
      'hook.example.com/a': {
        status: 200,
        headers: { 'content-type': ['Audio/MPEG; x=1'] as unknown as string },
        body: Buffer.from('a'),
      },
    });
    const response = await safeFetch(
      'https://hook.example.com/a',
      base,
      transport,
    );
    expect(response.contentType).toBe('audio/mpeg');
  });

  it.each([
    ['an empty DNS answer', 'https://empty.example.com/a', {}, 'dns'],
    [
      'a malformed redirect target',
      'https://hook.example.com/r',
      {
        'hook.example.com/r': {
          status: 302,
          headers: { location: 'https://[::1' },
        },
      },
      'invalid_url',
    ],
    ['a refused connection', 'https://hook.example.com/none', {}, 'network'],
    [
      'an idle socket',
      'https://hook.example.com/idle',
      { 'hook.example.com/idle': { status: 200, socketTimeout: true } },
      'timeout',
    ],
  ])('reports %s', async (_label, url, script, expected) => {
    expect(
      await reason(safeFetch(url, base, scriptedTransport(names, script))),
    ).toBe(expected);
  });

  it('reports a transport that throws as unreachable', async () => {
    const transport = scriptedTransport(names, {});
    transport.request = () => {
      throw new Error('fictional');
    };
    expect(
      await reason(safeFetch('https://hook.example.com/a', base, transport)),
    ).toBe('network');
  });

  it('reports a deadline already spent as a timeout', async () => {
    expect(
      await reason(
        safeFetch(
          'https://hook.example.com/a',
          { ...base, timeoutMs: 0 },
          scriptedTransport(names, {}),
        ),
      ),
    ).toBe('timeout');
  });

  it('resolves real names with the system resolver and refuses a local one', async () => {
    const local = await defaultResolve('localhost');
    expect(local.length).toBeGreaterThan(0);
    expect(typeof local[0].address).toBe('string');
    await expect(defaultResolve('name.invalid')).rejects.toBeDefined();
    await expect(checkedAddress('localhost')).rejects.toMatchObject({
      reason: 'address',
    });
  });

  it('uses the system resolver and transport by default, refusing before any connection', async () => {
    expect(await reason(safeFetch('https://127.0.0.1/a.mp3', base))).toBe(
      'address',
    );
  });

  it('refuses a content type with no media type', async () => {
    const transport = scriptedTransport(names, {
      'hook.example.com/a': {
        status: 200,
        headers: { 'content-type': '; charset=utf-8' },
        body: Buffer.from('a'),
      },
    });
    expect(
      await reason(safeFetch('https://hook.example.com/a', base, transport)),
    ).toBe('content_type');
  });

  it('builds an https or http request on the real transport', () => {
    for (const scheme of ['https:', 'http:'] as const) {
      const req = defaultRequest(scheme, {
        hostname: '192.0.2.1',
        path: '/',
        lookup: pinnedLookup({ address: '192.0.2.1', family: 4 }),
      });
      req.on('error', () => undefined);
      req.destroy();
      expect(req.method).toBe('GET');
    }
  });
});

describe('checked address and pinned lookup', () => {
  it('pins the connection to the checked address for single and all lookups', async () => {
    const pinned = await checkedAddress('media.example.com', () =>
      Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    );
    const lookup = pinnedLookup(pinned);
    const single = await new Promise((resolve) =>
      lookup('media.example.com', {}, (_e, address, family) =>
        resolve([address, family]),
      ),
    );
    expect(single).toEqual(['93.184.216.34', 4]);
    const all = await new Promise((resolve) =>
      lookup('media.example.com', { all: true }, (_e, addresses) =>
        resolve(addresses),
      ),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const short = await new Promise((resolve) =>
      (
        lookup as unknown as (
          h: string,
          cb: (e: null, a: string) => void,
        ) => void
      )('media.example.com', (_e, address) => resolve(address)),
    );
    expect(short).toBe('93.184.216.34');
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::127.0.0.1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    'not-an-address',
  ])('classifies %s as not public', (address) => {
    expect(unsafeAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '64:ff9b::808:808',
  ])('classifies %s as public', (address) => {
    expect(unsafeAddress(address)).toBe(false);
  });
});
