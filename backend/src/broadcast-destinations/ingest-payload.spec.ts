import {
  IngestPayloadError,
  YOUTUBE_INGEST_URL,
  parseIngestPayload,
  payloadFromIngestUrl,
} from './ingest-payload';

const KEY = 'live_abcd-1234';
const base = {
  scheme: 'rtmps',
  host: 'a.rtmps.youtube.com',
  port: 443,
  application: 'live2',
  streamKey: KEY,
};

describe('ingest payload', () => {
  it('parses the shape Croccante reads, with and without a port', () => {
    expect(parseIngestPayload(base)).toEqual({
      payload: base,
      ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
    });
    expect(parseIngestPayload({ ...base, port: undefined }).ingestUrl).toBe(
      'rtmps://a.rtmps.youtube.com/live2',
    );
    expect(
      parseIngestPayload({ ...base, host: '2001:db8::1', scheme: 'rtmp' })
        .ingestUrl,
    ).toBe('rtmp://[2001:db8::1]:443/live2');
    expect(parseIngestPayload({ ...base, host: '10.0.0.5' }).ingestUrl).toBe(
      'rtmps://10.0.0.5:443/live2',
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an unknown field', { ...base, token: 'x' }],
    ['a bad scheme', { ...base, scheme: 'http' }],
    ['no host', { ...base, host: undefined }],
    ['a bad host', { ...base, host: 'bad host!' }],
    ['no application', { ...base, application: undefined }],
    ['a bad application', { ...base, application: '-x' }],
    ['a climbing application', { ...base, application: 'a/../b' }],
    ['no key', { ...base, streamKey: undefined }],
    ['an empty key', { ...base, streamKey: '' }],
    ['a long key', { ...base, streamKey: 'k'.repeat(513) }],
    ['a key with a space', { ...base, streamKey: 'a b' }],
    ['a key with a control character', { ...base, streamKey: 'a\u0001b' }],
    ['a string port', { ...base, port: '443' }],
    ['a fractional port', { ...base, port: 1.5 }],
    ['port zero', { ...base, port: 0 }],
    ['a huge port', { ...base, port: 70000 }],
  ])('refuses %s, with text that has no key in it', (_name, value) => {
    let error: unknown;
    try {
      parseIngestPayload(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IngestPayloadError);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('builds a payload from an ingest URL and writes what it reads', () => {
    const built = payloadFromIngestUrl(YOUTUBE_INGEST_URL, KEY);
    expect(built.payload).toEqual(base);
    expect(parseIngestPayload(built.payload).ingestUrl).toBe(built.ingestUrl);
    expect(
      payloadFromIngestUrl('rtmp://example.test/live/', KEY).payload,
    ).toEqual({
      scheme: 'rtmp',
      host: 'example.test',
      application: 'live',
      streamKey: KEY,
    });
    expect(
      payloadFromIngestUrl('rtmp://[2001:db8::1]:1935/a/b', KEY).payload.host,
    ).toBe('2001:db8::1');
  });

  it.each([
    ['not a URL', 'not a url'],
    ['http', 'http://example.test/live'],
    ['no application', 'rtmp://example.test'],
    ['credentials', 'rtmp://user:pw@example.test/live'],
    ['a query', 'rtmp://example.test/live?x=1'],
    ['a fragment', 'rtmp://example.test/live#x'],
    ['a space in the path', 'rtmp://example.test/live 2'],
  ])('refuses an ingest URL with %s', (_name, url) => {
    expect(() => payloadFromIngestUrl(url, KEY)).toThrow(IngestPayloadError);
  });
});
