/* eslint-disable @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AudioAnalysisError,
  FfmpegAudioAnalyzer,
  INPUT_DIRECTORY_PREFIX,
  INPUT_USER_AGENT,
  MAX_INPUT_BYTES,
  measureArguments,
  probeArguments,
  type RemoteInputPolicy,
} from './ffmpeg-audio.analyzer';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  scriptedTransport,
  type ScriptedResponse,
} from '../outbound/safe-fetch.testing';
import { ProcessRunError, type ProcessRunner } from './process-runner';

// A remote analysis input is fetched through the outbound-request policy into
// a private temporary file; ffprobe and ffmpeg only ever read that file, so
// the address that was checked is the address that was read.

const PROBE = JSON.stringify({ streams: [{}], format: {} });
const MEASURE_STDERR = `[silencedetect @ 0x2] silence_start: 0
[silencedetect @ 0x2] silence_end: 1 | silence_duration: 1
[Parsed_ebur128_1 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.0 LUFS

  True peak:
    Peak:       -1.0 dBFS
`;
const MEASURE_STDOUT = 'out_time_us=200000000\nprogress=end\n';
const AUDIO = Buffer.from('ID3 placeholder audio bytes');
const NETWORK_ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;

const names: Record<string, string[]> = {
  // The managed media bucket and its CDN resolve to public addresses.
  'alcantara-media.s3.us-east-1.amazonaws.com': ['52.216.8.1'],
  'media.cdn.example.com': ['2600:9000:2000::1', '13.32.0.1'],
  'inside.example.com': ['10.0.0.8'],
  'mixed.example.com': ['93.184.216.34', '192.168.0.4'],
};

const served: ScriptedResponse = {
  status: 200,
  headers: { 'content-type': 'audio/mpeg' },
  body: [AUDIO.subarray(0, 4), AUDIO.subarray(4)],
};

const script: Record<string, ScriptedResponse> = {
  'alcantara-media.s3.us-east-1.amazonaws.com/audio/a.mp3': served,
  'media.cdn.example.com/a.mp3': served,
  'media.cdn.example.com/audio/a.mp3': served,
  'media.cdn.example.com/moved.mp3': {
    status: 302,
    headers: {
      location:
        'https://alcantara-media.s3.us-east-1.amazonaws.com/audio/a.mp3',
    },
  },
  'media.cdn.example.com/page.html': {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<html>'),
  },
  'media.cdn.example.com/huge.mp3': {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(MAX_INPUT_BYTES + 1),
    },
  },
  'media.cdn.example.com/missing.mp3': { status: 404 },
  'media.cdn.example.com/slow.mp3': { status: 200, hang: true },
};

let tempRoot: string;
beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'analysis-spec-'));
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Nothing is left behind in the temporary root. */
function leftovers() {
  return readdirSync(tempRoot);
}

function build(
  overrides: Partial<RemoteInputPolicy> = {},
  tool: (
    command: string,
    args: string[],
  ) => Promise<{
    stdout: string;
    stderr: string;
  }> = async (command) =>
    command === 'ffprobe'
      ? { stdout: PROBE, stderr: '' }
      : { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
) {
  const read: Buffer[] = [];
  const run = jest.fn<ReturnType<ProcessRunner>, Parameters<ProcessRunner>>(
    async (command, args) => {
      // ffprobe takes the input last; ffmpeg after -i.
      const input =
        command === 'ffprobe'
          ? args[args.length - 1]
          : args[args.indexOf('-i') + 1];
      read.push(readFileSync(input));
      return tool(command, args);
    },
  );
  const transport = scriptedTransport(names, script);
  const metrics = new ManagedMetricsService();
  const analyzer = new FfmpegAudioAnalyzer(run, {
    resolve: transport.resolve,
    request: transport.request,
    record: (path, result) => metrics.recordOutboundFetch(path, result),
    tempRoot,
    ...overrides,
  });
  const count = async (result: string) => {
    const text = await metrics.registry.metrics();
    const line = text
      .split('\n')
      .find((sample) =>
        sample.startsWith(
          `alcantara_outbound_fetch_total{path="media_analysis",result="${result}"}`,
        ),
      );
    return Number(line?.split(' ').pop());
  };
  return { run, read, analyzer, count, metrics, sent: transport.sent };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AudioAnalysisError);
  return error as AudioAnalysisError;
}

describe('remote analysis input policy', () => {
  it('analyses a source in the managed bucket and on its CDN from the fetched bytes', async () => {
    const { run, read, analyzer, count, sent } = build();
    for (const url of [
      'https://alcantara-media.s3.us-east-1.amazonaws.com/audio/a.mp3',
      'https://media.cdn.example.com/audio/a.mp3',
    ]) {
      await expect(analyzer.analyze(url, 10_000)).resolves.toMatchObject({
        durationSeconds: 200,
        integratedLufs: -14,
      });
    }
    expect(run).toHaveBeenCalledTimes(4);
    for (const bytes of read) expect(bytes.equals(AUDIO)).toBe(true);
    expect(await count('ok')).toBe(2);
    // One chosen header besides Host; no cookie or credential is ever sent.
    for (const request of sent) {
      expect(request.method).toBe('GET');
      expect(request.headers).toEqual({
        'user-agent': INPUT_USER_AGENT,
        host: request.hostname,
      });
    }
    expect(leftovers()).toEqual([]);
  });

  it('never passes a network address to ffprobe or ffmpeg, only the private file', async () => {
    const { run, analyzer } = build();
    await analyzer.analyze('https://media.cdn.example.com/a.mp3', 10_000);
    await analyzer.analyze('http://media.cdn.example.com/a.mp3', 10_000);
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'ffprobe',
      'ffmpeg',
      'ffprobe',
      'ffmpeg',
    ]);
    for (const [, args] of run.mock.calls) {
      expect(args.filter((arg) => NETWORK_ADDRESS.test(arg))).toEqual([]);
      expect(args.join(' ')).not.toContain('example.com');
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
      expect(args).not.toContain('-max_redirects');
      expect(args).not.toContain('-rw_timeout');
      const input = args.find((arg) => arg.startsWith(tempRoot));
      expect(input).toMatch(
        new RegExp(`^${tempRoot}/${INPUT_DIRECTORY_PREFIX}[^/]+/input$`),
      );
    }
    expect(measureArguments('/tmp/a.mp3')).toContain('file');
    expect(probeArguments('/tmp/a.mp3')).toContain('file');
  });

  it('reads the address it checked: a name that turns private on a second lookup is never looked up again', async () => {
    const lookups: string[] = [];
    const answers = [['93.184.216.34'], ['10.0.0.8']];
    const transport = scriptedTransport(names, script);
    const { run, read, analyzer, sent } = build({
      resolve: async (hostname) => {
        lookups.push(hostname);
        const next = answers[Math.min(lookups.length - 1, 1)];
        return next.map((address) => ({ address, family: 4 }));
      },
      request: (scheme, options) =>
        transport.request(scheme, {
          ...options,
          // The scripted server is keyed by the CDN name.
          hostname: 'media.cdn.example.com',
        }),
    });
    await analyzer.analyze('https://rebind.example.com/a.mp3', 10_000);
    expect(lookups).toEqual(['rebind.example.com']);
    expect(sent).toHaveLength(0);
    expect(transport.sent.map((request) => request.connectedTo)).toEqual([
      '93.184.216.34',
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    for (const bytes of read) expect(bytes.equals(AUDIO)).toBe(true);
  });

  it.each([
    ['private', 'https://10.1.2.3/a.mp3'],
    ['loopback', 'https://127.0.0.1/a.mp3'],
    ['IPv6 loopback', 'https://[::1]/a.mp3'],
    ['link-local', 'https://169.254.169.254/latest/a.mp3'],
    ['a name resolving to private', 'https://inside.example.com/a.mp3'],
    ['a name resolving partly to private', 'https://mixed.example.com/a.mp3'],
  ])(
    'refuses a %s source without connecting or running a tool',
    async (_case, url) => {
      const { run, analyzer, count, sent } = build();
      const error = await failure(analyzer.analyze(url, 10_000));
      expect(error.code).toBe('source-refused');
      expect(error.retryable).toBe(false);
      expect(error.message).toBe('Audio analysis failed: source-refused');
      expect(run).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      expect(await count('address')).toBe(1);
      expect(leftovers()).toEqual([]);
    },
  );

  it('refuses a source with a user name or password, or that does not parse', async () => {
    const { run, analyzer, count } = build();
    for (const url of [
      'https://user:pass@media.cdn.example.com/a.mp3',
      'https://:pass@media.cdn.example.com/a.mp3',
      'http://',
    ]) {
      expect((await failure(analyzer.analyze(url, 10_000))).code).toBe(
        'source-refused',
      );
    }
    expect(run).not.toHaveBeenCalled();
    expect(await count('invalid_url')).toBe(3);
  });

  it.each([
    ['a redirect', 'moved.mp3', 'redirects', 'source-refused', false],
    [
      'a non-audio answer',
      'page.html',
      'content_type',
      'source-refused',
      false,
    ],
    [
      'an answer over the cap',
      'huge.mp3',
      'too_large',
      'source-refused',
      false,
    ],
    [
      'an error status',
      'missing.mp3',
      'http_status',
      'source-unavailable',
      true,
    ],
    [
      'a refused connection',
      'nobody.mp3',
      'network',
      'source-unavailable',
      true,
    ],
  ])(
    'fails %s without running a tool, leaving no file',
    async (_case, path, result, code, retryable) => {
      const { run, analyzer, count, sent } = build();
      const error = await failure(
        analyzer.analyze(`https://media.cdn.example.com/${path}`, 10_000),
      );
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(run).not.toHaveBeenCalled();
      // A redirect is never followed.
      expect(sent).toHaveLength(1);
      expect(await count(result)).toBe(1);
      expect(leftovers()).toEqual([]);
    },
  );

  it('retries a source whose host does not resolve', async () => {
    const { run, analyzer, count } = build();
    const error = await failure(
      analyzer.analyze('https://unknown.example.com/a.mp3', 10_000),
    );
    expect(error.code).toBe('source-unresolved');
    expect(error.retryable).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(await count('dns')).toBe(1);
  });

  it('times out a fetch that outlives the deadline, or a deadline already spent, and leaves no file', async () => {
    const { run, analyzer, count } = build();
    const slow = await failure(
      analyzer.analyze('https://media.cdn.example.com/slow.mp3', 20),
    );
    expect(slow.code).toBe('timeout');
    expect(await count('timeout')).toBe(1);
    const spent = await failure(
      analyzer.analyze('https://media.cdn.example.com/a.mp3', -1),
    );
    expect(spent.code).toBe('timeout');
    expect(run).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it('removes the fetched file when a tool fails or times out', async () => {
    for (const [failure_, code] of [
      ['exit', 'probe-failed'],
      ['timeout', 'timeout'],
    ] as const) {
      const { analyzer } = build({}, async () => {
        throw new ProcessRunError(failure_);
      });
      expect(
        (
          await failure(
            analyzer.analyze('https://media.cdn.example.com/a.mp3', 10_000),
          )
        ).code,
      ).toBe(code);
      expect(leftovers()).toEqual([]);
    }
    const { analyzer } = build({}, async (command) =>
      command === 'ffprobe'
        ? { stdout: PROBE, stderr: '' }
        : { stdout: MEASURE_STDOUT, stderr: 'no summary' },
    );
    expect(
      (
        await failure(
          analyzer.analyze('https://media.cdn.example.com/a.mp3', 10_000),
        )
      ).code,
    ).toBe('invalid-measurement');
    expect(leftovers()).toEqual([]);
  });

  it('counts a plain http source as legacy_http and still checks it', async () => {
    const { analyzer, count } = build();
    await analyzer.analyze('http://media.cdn.example.com/a.mp3', 10_000);
    expect(await count('legacy_http')).toBe(1);
    expect(
      (
        await failure(
          analyzer.analyze('http://inside.example.com/a.mp3', 10_000),
        )
      ).code,
    ).toBe('source-refused');
  });

  it('reads a local file in place, fetching nothing, and works without a policy', async () => {
    const local = join(tempRoot, 'local.mp3');
    writeFileSync(local, AUDIO);
    const { run, sent } = build();
    const analyzer = new FfmpegAudioAnalyzer(run);
    await expect(analyzer.analyze(local, 10_000)).resolves.toBeTruthy();
    expect(run.mock.calls[0][1]).toContain(local);
    expect(sent).toHaveLength(0);
    expect(leftovers()).toEqual(['local.mp3']);
  });

  it('uses the OS temporary directory by default and removes its file', async () => {
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(INPUT_DIRECTORY_PREFIX),
    );
    const { analyzer, read } = build({ tempRoot: undefined });
    await analyzer.analyze('https://media.cdn.example.com/a.mp3', 10_000);
    expect(read[0].equals(AUDIO)).toBe(true);
    const after = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(INPUT_DIRECTORY_PREFIX),
    );
    expect(after).toEqual(before);
  });

  it('puts no URL or host in a metric label', async () => {
    const { analyzer, metrics } = build();
    await failure(analyzer.analyze('https://inside.example.com/a.mp3', 10_000));
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('10.0.0.8');
    expect(existsSync(tempRoot)).toBe(true);
  });
});
