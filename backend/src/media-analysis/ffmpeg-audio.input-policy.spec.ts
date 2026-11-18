/* eslint-disable @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import {
  AudioAnalysisError,
  FfmpegAudioAnalyzer,
  measureArguments,
  probeArguments,
} from './ffmpeg-audio.analyzer';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { ProcessRunner } from './process-runner';

// A remote analysis input is checked against the outbound-request policy
// before ffprobe or ffmpeg runs: every address its host resolves to must be
// public, and the tools follow no redirect.

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

const names: Record<string, string[]> = {
  // The managed media bucket and its CDN resolve to public addresses.
  'alcantara-media.s3.us-east-1.amazonaws.com': ['52.216.8.1'],
  'media.cdn.example.com': ['2600:9000:2000::1', '13.32.0.1'],
  'inside.example.com': ['10.0.0.8'],
  'mixed.example.com': ['93.184.216.34', '192.168.0.4'],
};

function build() {
  const run = jest.fn<ReturnType<ProcessRunner>, Parameters<ProcessRunner>>(
    async (command) =>
      command === 'ffprobe'
        ? { stdout: PROBE, stderr: '' }
        : { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
  );
  const metrics = new ManagedMetricsService();
  const analyzer = new FfmpegAudioAnalyzer(run, {
    resolve: async (hostname) => {
      const addresses = names[hostname];
      if (!addresses) throw new Error('ENOTFOUND');
      return addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }));
    },
    record: (path, result) => metrics.recordOutboundFetch(path, result),
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
  return { run, analyzer, count, metrics };
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
  it('analyses a source in the managed bucket and on its CDN', async () => {
    const { run, analyzer, count } = build();
    for (const url of [
      'https://alcantara-media.s3.us-east-1.amazonaws.com/audio/a.mp3',
      'https://media.cdn.example.com/audio/a.mp3',
    ]) {
      await expect(analyzer.analyze(url, 10_000)).resolves.toMatchObject({
        durationSeconds: 200,
      });
    }
    expect(run).toHaveBeenCalledTimes(4);
    expect(await count('ok')).toBe(2);
  });

  it('passes -max_redirects 0 to both tools for a remote input, keeping the whitelist and read timeout', async () => {
    const { run, analyzer } = build();
    await analyzer.analyze('https://media.cdn.example.com/a.mp3', 10_000);
    for (const [command, args] of run.mock.calls) {
      expect(['ffprobe', 'ffmpeg']).toContain(command);
      const at = args.indexOf('-max_redirects');
      expect(args[at + 1]).toBe('0');
      expect(args).toEqual(
        expect.arrayContaining([
          '-protocol_whitelist',
          'http,https,tcp,tls,crypto',
          '-rw_timeout',
          '30000000',
        ]),
      );
      // Input options come before the input itself.
      expect(at).toBeLessThan(
        args.indexOf('https://media.cdn.example.com/a.mp3'),
      );
    }
    expect(measureArguments('/tmp/a.mp3')).not.toContain('-max_redirects');
    expect(probeArguments('http://media.cdn.example.com/a.mp3')).toContain(
      '-max_redirects',
    );
  });

  it.each([
    ['private', 'https://10.1.2.3/a.mp3'],
    ['loopback', 'https://127.0.0.1/a.mp3'],
    ['IPv6 loopback', 'https://[::1]/a.mp3'],
    ['link-local', 'https://169.254.169.254/latest/a.mp3'],
    ['a name resolving to private', 'https://inside.example.com/a.mp3'],
    ['a name resolving partly to private', 'https://mixed.example.com/a.mp3'],
  ])('refuses a %s source without running a tool', async (_case, url) => {
    const { run, analyzer, count } = build();
    const error = await failure(analyzer.analyze(url, 10_000));
    expect(error.code).toBe('source-refused');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Audio analysis failed: source-refused');
    expect(run).not.toHaveBeenCalled();
    expect(await count('address')).toBe(1);
  });

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

  it('times out a lookup that outlives the deadline', async () => {
    const run = jest.fn<ReturnType<ProcessRunner>, Parameters<ProcessRunner>>();
    const recorded: string[] = [];
    const analyzer = new FfmpegAudioAnalyzer(run, {
      resolve: () => new Promise(() => undefined),
      record: (_path, result) => recorded.push(result),
    });
    const error = await failure(
      analyzer.analyze('https://slow.example.com/a.mp3', 5),
    );
    expect(error.code).toBe('timeout');
    expect(recorded).toEqual(['timeout']);
    expect(run).not.toHaveBeenCalled();
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

  it('checks nothing for a local file and works without a recorder', async () => {
    const { run } = build();
    const analyzer = new FfmpegAudioAnalyzer(run);
    await expect(analyzer.analyze('/tmp/a.mp3', 10_000)).resolves.toBeTruthy();
    const remote = new FfmpegAudioAnalyzer(run, {
      resolve: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    expect(
      (await failure(remote.analyze('https://x.example.com/a.mp3', 10_000)))
        .code,
    ).toBe('source-refused');
  });

  it('puts no URL or host in a metric label', async () => {
    const { analyzer, metrics } = build();
    await failure(analyzer.analyze('https://inside.example.com/a.mp3', 10_000));
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('10.0.0.8');
  });
});
