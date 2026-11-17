/* eslint-disable @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import {
  AudioAnalysisError,
  assertPlayable,
  cuePoints,
  FfmpegAudioAnalyzer,
  measureArguments,
  normalizeIsrc,
  normalizeMusicbrainzId,
  parseDecodedDuration,
  parseLoudness,
  parseProbe,
  parseSilence,
  probeArguments,
} from './ffmpeg-audio.analyzer';
import { ProcessRunError, type ProcessRunner } from './process-runner';

const SUMMARY = `[Parsed_ebur128_1 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.4 LUFS

  Loudness range:
    LRA:         5.0 LU

  True peak:
    Peak:       -0.8 dBFS
`;

const PROBE = JSON.stringify({
  streams: [{ tags: { ISRC: 'gb-aaa-26-00001' } }],
  format: {
    tags: { 'MusicBrainz Track Id': 'F5093C06-23E3-404F-AEAA-40F72885EE3A' },
  },
});

const MEASURE_STDERR = `[silencedetect @ 0x2] silence_start: 0
[silencedetect @ 0x2] silence_end: 1.5004 | silence_duration: 1.5004
[silencedetect @ 0x2] silence_start: 120.2
[silencedetect @ 0x2] silence_end: 121 | silence_duration: 0.8
[silencedetect @ 0x2] silence_start: 238.0001
[silencedetect @ 0x2] silence_end: 240 | silence_duration: 1.9999
${SUMMARY}`;

const MEASURE_STDOUT =
  'out_time_us=120000000\nprogress=continue\nout_time_us=240000000\nprogress=end\n';

async function analysisError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioAnalysisError);
    return (error as AudioAnalysisError).code;
  }
  throw new Error('expected an analysis error');
}

function syncError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioAnalysisError);
    return (error as AudioAnalysisError).code;
  }
  throw new Error('expected an analysis error');
}

describe('ffmpeg audio analyzer parsing', () => {
  it('limits network inputs to network protocols and local inputs to files', () => {
    expect(probeArguments('https://cdn.example/a.mp3')).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'http,https,tcp,tls,crypto',
      ]),
    );
    expect(measureArguments('/tmp/a.mp3')).toEqual(
      expect.arrayContaining(['-protocol_whitelist', 'file', '-threads', '1']),
    );
    expect(measureArguments('/tmp/a.mp3')).toContain(
      'silencedetect=noise=-50dB:d=0.5,ebur128=peak=true:framelog=quiet',
    );
  });

  it('keeps only well-formed identifiers', () => {
    expect(normalizeIsrc(null)).toBeNull();
    expect(normalizeIsrc('us-rc1-76-07839')).toBe('USRC17607839');
    expect(normalizeIsrc('not an isrc')).toBeNull();
    expect(normalizeMusicbrainzId(null)).toBeNull();
    expect(
      normalizeMusicbrainzId(' F5093C06-23E3-404F-AEAA-40F72885EE3A '),
    ).toBe('f5093c06-23e3-404f-aeaa-40f72885ee3a');
    expect(normalizeMusicbrainzId('f5093c06')).toBeNull();
  });

  it('reads identifiers from format and stream tags, format first', () => {
    expect(parseProbe(PROBE)).toEqual({
      isrc: 'GBAAA2600001',
      musicbrainzRecordingId: 'f5093c06-23e3-404f-aeaa-40f72885ee3a',
    });
    expect(
      parseProbe(
        JSON.stringify({
          streams: [{ tags: { TSRC: 'USRC17607839', count: 3 } }],
          format: { tags: { tsrc: 'GBAAA2600001' } },
        }),
      ),
    ).toEqual({ isrc: 'GBAAA2600001', musicbrainzRecordingId: null });
    expect(parseProbe(JSON.stringify({ streams: [{}] }))).toEqual({
      isrc: null,
      musicbrainzRecordingId: null,
    });
  });

  it('fails a probe that is not JSON, and a file without audio', () => {
    expect(syncError(() => parseProbe('nope'))).toBe('probe-failed');
    expect(syncError(() => parseProbe('null'))).toBe('probe-failed');
    expect(syncError(() => parseProbe('{"streams":[]}'))).toBe('no-audio');
    expect(syncError(() => parseProbe('{"streams":{}}'))).toBe('no-audio');
  });

  it('pairs silence starts with their ends', () => {
    expect(parseSilence(MEASURE_STDERR)).toEqual([
      { start: 0, end: 1.5004 },
      { start: 120.2, end: 121 },
      { start: 238.0001, end: 240 },
    ]);
    expect(
      parseSilence(
        'silence_end: 1\nsilence_start: 3\nsilence_end: 4\nsilence_end: 5\nsilence_start: 9',
      ),
    ).toEqual([
      { start: 3, end: 4 },
      { start: 9, end: null },
    ]);
  });

  it('reads integrated loudness and true peak from the last summary', () => {
    expect(
      parseLoudness(`${SUMMARY.replace('-14.2', '-30')}\n${SUMMARY}`),
    ).toEqual({
      integratedLufs: -14.2,
      truePeakDbtp: -0.8,
    });
    expect(
      parseLoudness(SUMMARY.replace('-0.8', '-inf')).truePeakDbtp,
    ).toBeNaN();
    expect(syncError(() => parseLoudness('no summary'))).toBe(
      'invalid-measurement',
    );
    expect(syncError(() => parseLoudness('Summary:\n I: -14 LUFS'))).toBe(
      'invalid-measurement',
    );
  });

  it('reads the decoded length from the last progress report', () => {
    expect(parseDecodedDuration(MEASURE_STDOUT)).toBe(240);
    expect(syncError(() => parseDecodedDuration('progress=end'))).toBe(
      'decode-failed',
    );
    expect(syncError(() => parseDecodedDuration('out_time_us=0'))).toBe(
      'decode-failed',
    );
  });

  it('places cues only at edges that have silence', () => {
    const periods = parseSilence(MEASURE_STDERR);
    expect(cuePoints(periods, 240)).toEqual({
      cueInSeconds: 1.5,
      cueOutSeconds: 238,
    });
    expect(cuePoints([], 240)).toEqual({
      cueInSeconds: null,
      cueOutSeconds: null,
    });
    expect(cuePoints([{ start: 120, end: 121 }], 240)).toEqual({
      cueInSeconds: null,
      cueOutSeconds: null,
    });
    expect(cuePoints([{ start: 0.04, end: 2 }], 240)).toEqual({
      cueInSeconds: 2,
      cueOutSeconds: null,
    });
    expect(cuePoints([{ start: 230, end: null }], 240)).toEqual({
      cueInSeconds: null,
      cueOutSeconds: 230,
    });
    expect(cuePoints([{ start: 230, end: 239.96 }], 240)).toEqual({
      cueInSeconds: null,
      cueOutSeconds: 230,
    });
    expect(syncError(() => cuePoints([{ start: 0, end: 240 }], 240))).toBe(
      'silent',
    );
    expect(syncError(() => cuePoints([{ start: 0, end: null }], 240))).toBe(
      'silent',
    );
  });

  it('accepts only values the Palazzo client would accept', () => {
    const analysis = {
      durationSeconds: 240,
      cueInSeconds: null,
      cueOutSeconds: null,
      integratedLufs: -14,
      truePeakDbtp: -1,
      isrc: null,
      musicbrainzRecordingId: null,
    };
    expect(() => assertPlayable(analysis)).not.toThrow();
    expect(() =>
      assertPlayable({ ...analysis, cueInSeconds: 1, cueOutSeconds: 239 }),
    ).not.toThrow();
    for (const bad of [
      { integratedLufs: -71 },
      { integratedLufs: 0.5 },
      { truePeakDbtp: 6.1 },
      { truePeakDbtp: Number.NaN },
      { cueOutSeconds: 241 },
      { cueInSeconds: 240 },
    ]) {
      expect(syncError(() => assertPlayable({ ...analysis, ...bad }))).toBe(
        'invalid-measurement',
      );
    }
  });

  it('separates failures a second run can change from those it cannot', () => {
    expect(new AudioAnalysisError('timeout').retryable).toBe(true);
    expect(new AudioAnalysisError('decode-failed').retryable).toBe(true);
    expect(new AudioAnalysisError('silent').retryable).toBe(false);
    expect(new AudioAnalysisError('no-audio').retryable).toBe(false);
    expect(new AudioAnalysisError('invalid-measurement').retryable).toBe(false);
  });
});

describe('FfmpegAudioAnalyzer', () => {
  function runner(
    responses: Record<
      string,
      { stdout: string; stderr: string } | ProcessRunError
    >,
  ) {
    const run = jest.fn<ReturnType<ProcessRunner>, Parameters<ProcessRunner>>(
      async (command) => {
        const response = responses[command];
        if (response instanceof ProcessRunError) throw response;
        return response;
      },
    );
    return run;
  }

  it('probes, then measures within one deadline', async () => {
    const run = runner({
      ffprobe: { stdout: PROBE, stderr: '' },
      ffmpeg: { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
    });
    const analyzer = new FfmpegAudioAnalyzer(run);

    await expect(
      analyzer.analyze('https://cdn.example/a.mp3', 180_000),
    ).resolves.toEqual({
      durationSeconds: 240,
      cueInSeconds: 1.5,
      cueOutSeconds: 238,
      integratedLufs: -14.2,
      truePeakDbtp: -0.8,
      isrc: 'GBAAA2600001',
      musicbrainzRecordingId: 'f5093c06-23e3-404f-aeaa-40f72885ee3a',
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'ffprobe',
      'ffmpeg',
    ]);
    for (const [, args, options] of run.mock.calls) {
      expect(args).toContain('https://cdn.example/a.mp3');
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(180_000);
      expect(options.maxOutputBytes).toBe(4 * 1024 * 1024);
    }
  });

  it('maps each process failure to a stored code', async () => {
    const cases: Array<[string, ProcessRunError, string]> = [
      ['ffprobe', new ProcessRunError('spawn'), 'unavailable'],
      ['ffprobe', new ProcessRunError('timeout'), 'timeout'],
      ['ffprobe', new ProcessRunError('output-limit'), 'output-limit'],
      ['ffprobe', new ProcessRunError('exit'), 'probe-failed'],
      ['ffmpeg', new ProcessRunError('exit'), 'decode-failed'],
    ];
    for (const [tool, error, code] of cases) {
      const run = runner({
        ffprobe: { stdout: PROBE, stderr: '' },
        ffmpeg: { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
        [tool]: error,
      });
      await expect(
        analysisError(
          new FfmpegAudioAnalyzer(run).analyze('https://x/a.mp3', 1_000),
        ),
      ).resolves.toBe(code);
    }
  });

  it('fails a measurement outside the Palazzo bounds', async () => {
    const run = runner({
      ffprobe: { stdout: PROBE, stderr: '' },
      ffmpeg: {
        stdout: MEASURE_STDOUT,
        stderr: MEASURE_STDERR.replace('-0.8 dBFS', '-inf dBFS'),
      },
    });
    await expect(
      analysisError(
        new FfmpegAudioAnalyzer(run).analyze('https://x/a.mp3', 1_000),
      ),
    ).resolves.toBe('invalid-measurement');
  });

  it('times out without starting a tool once the deadline has passed', async () => {
    const run = runner({
      ffprobe: { stdout: PROBE, stderr: '' },
      ffmpeg: { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
    });
    await expect(
      analysisError(new FfmpegAudioAnalyzer(run).analyze('https://x/a.mp3', 0)),
    ).resolves.toBe('timeout');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports whether both tools start', async () => {
    const ok = runner({
      ffprobe: { stdout: 'ffprobe version', stderr: '' },
      ffmpeg: { stdout: 'ffmpeg version', stderr: '' },
      nice: { stdout: 'ffprobe version', stderr: '' },
    });
    const analyzer = new FfmpegAudioAnalyzer(ok);
    expect(analyzer.lowPriority).toBe(false);
    await expect(analyzer.available(1_000)).resolves.toBe(true);
    expect(analyzer.lowPriority).toBe(true);
    expect(ok.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['ffprobe', ['-hide_banner', '-version']],
      ['ffmpeg', ['-hide_banner', '-version']],
      ['nice', ['-n', '19', 'ffprobe', '-hide_banner', '-version']],
    ]);

    const missing = runner({
      ffprobe: { stdout: '', stderr: '' },
      ffmpeg: new ProcessRunError('spawn'),
    });
    await expect(
      new FfmpegAudioAnalyzer(missing).available(1_000),
    ).resolves.toBe(false);
  });

  it('runs both tools through nice at the lowest priority when nice starts', async () => {
    const run = runner({
      nice: { stdout: '', stderr: '' },
      ffprobe: { stdout: 'version', stderr: '' },
      ffmpeg: { stdout: 'version', stderr: '' },
    });
    const analyzer = new FfmpegAudioAnalyzer(run);
    await analyzer.available(1_000);
    run.mockClear();
    run
      .mockResolvedValueOnce({ stdout: PROBE, stderr: '' })
      .mockResolvedValueOnce({
        stdout: MEASURE_STDOUT,
        stderr: MEASURE_STDERR,
      });

    await analyzer.analyze('https://x/a.mp3', 1_000);

    expect(
      run.mock.calls.map(([command, args]) => [command, args.slice(0, 3)]),
    ).toEqual([
      ['nice', ['-n', '19', 'ffprobe']],
      ['nice', ['-n', '19', 'ffmpeg']],
    ]);
    expect(run.mock.calls[1][1].slice(3)).toEqual(
      measureArguments('https://x/a.mp3'),
    );
  });

  it('runs the tools directly when nice is not installed', async () => {
    const run = runner({
      nice: new ProcessRunError('spawn'),
      ffprobe: { stdout: PROBE, stderr: '' },
      ffmpeg: { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
    });
    const analyzer = new FfmpegAudioAnalyzer(run);
    await expect(analyzer.available(1_000)).resolves.toBe(true);
    expect(analyzer.lowPriority).toBe(false);
    run.mockClear();

    await analyzer.analyze('https://x/a.mp3', 1_000);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'ffprobe',
      'ffmpeg',
    ]);
  });

  it('uses the real process runner by default', () => {
    expect(new FfmpegAudioAnalyzer()).toBeInstanceOf(FfmpegAudioAnalyzer);
  });
});
