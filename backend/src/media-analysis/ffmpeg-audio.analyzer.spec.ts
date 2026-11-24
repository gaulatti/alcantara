/* eslint-disable @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import {
  type AudioAnalysis,
  AudioAnalysisError,
  assertPlayable,
  CUE_RULE_VERSION,
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
  ruleCuePoints,
  silenceFilterChain,
  tailFilterName,
  tailThresholdDb,
} from './ffmpeg-audio.analyzer';
import { ProcessRunError, type ProcessRunner } from './process-runner';

// The tools always read a local file (a remote input is fetched first; see
// ffmpeg-audio.input-policy.spec.ts).
const LOCAL = '/media/a.mp3';

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

// Each detector of the chain logs under its own name. The loudness below (-14.2 LUFS, -0.8 dBTP) plays with
// a gain of -1.8 dB, so the tail detector read is tail43 (-45 + 1.8, rounded).
const MEASURE_STDERR = `[silencedetect@base @ 0x2] silence_start: 0
[silencedetect@base @ 0x2] silence_end: 1.5004 | silence_duration: 1.5004
[silencedetect@head @ 0x3] silence_start: 0
[silencedetect@head @ 0x3] silence_end: 1.5004 | silence_duration: 1.5004
[silencedetect@base @ 0x2] silence_start: 120.2
[silencedetect@base @ 0x2] silence_end: 121 | silence_duration: 0.8
[silencedetect@base @ 0x2] silence_start: 238.0001
[silencedetect@base @ 0x2] silence_end: 240 | silence_duration: 1.9999
[silencedetect@tail43 @ 0x4] silence_start: 237.2
[silencedetect@tail43 @ 0x4] silence_end: 240 | silence_duration: 2.8
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
  it('lets both tools open local files only', () => {
    expect(probeArguments(LOCAL)).toEqual(
      expect.arrayContaining(['-protocol_whitelist', 'file']),
    );
    expect(probeArguments(LOCAL)).not.toContain('-max_redirects');
    expect(measureArguments('/tmp/a.mp3')).toEqual(
      expect.arrayContaining(['-protocol_whitelist', 'file', '-threads', '1']),
    );
    expect(measureArguments('/tmp/a.mp3')).toContain(silenceFilterChain());
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
    expect(parseSilence(MEASURE_STDERR, 'base')).toEqual([
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
    const periods = parseSilence(MEASURE_STDERR, 'base');
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
    const analysis: AudioAnalysis = {
      durationSeconds: 240,
      cueInSeconds: null,
      cueOutSeconds: null,
      integratedLufs: -14,
      truePeakDbtp: -1,
      isrc: null,
      musicbrainzRecordingId: null,
      ruleVersion: CUE_RULE_VERSION,
      cueRule: { head: 'unchanged', tail: 'unchanged' },
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

    await expect(analyzer.analyze(LOCAL, 180_000)).resolves.toEqual({
      durationSeconds: 240,
      cueInSeconds: 1.5,
      // Rule 2: the tail43 detector (the song plays 1.8 dB lower) starts 0.8 s before rule 1's 238.
      cueOutSeconds: 237.2,
      integratedLufs: -14.2,
      truePeakDbtp: -0.8,
      isrc: 'GBAAA2600001',
      musicbrainzRecordingId: 'f5093c06-23e3-404f-aeaa-40f72885ee3a',
      ruleVersion: 2,
      cueRule: { head: 'unchanged', tail: 'applied' },
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'ffprobe',
      'ffmpeg',
    ]);
    for (const [, args, options] of run.mock.calls) {
      expect(args).toContain(LOCAL);
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
        analysisError(new FfmpegAudioAnalyzer(run).analyze(LOCAL, 1_000)),
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
      analysisError(new FfmpegAudioAnalyzer(run).analyze(LOCAL, 1_000)),
    ).resolves.toBe('invalid-measurement');
  });

  it('times out without starting a tool once the deadline has passed', async () => {
    const run = runner({
      ffprobe: { stdout: PROBE, stderr: '' },
      ffmpeg: { stdout: MEASURE_STDOUT, stderr: MEASURE_STDERR },
    });
    await expect(
      analysisError(new FfmpegAudioAnalyzer(run).analyze(LOCAL, 0)),
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

    await analyzer.analyze(LOCAL, 1_000);

    expect(
      run.mock.calls.map(([command, args]) => [command, args.slice(0, 3)]),
    ).toEqual([
      ['nice', ['-n', '19', 'ffprobe']],
      ['nice', ['-n', '19', 'ffmpeg']],
    ]);
    expect(run.mock.calls[1][1].slice(3)).toEqual(measureArguments(LOCAL));
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

    await analyzer.analyze(LOCAL, 1_000);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'ffprobe',
      'ffmpeg',
    ]);
  });

  it('uses the real process runner by default', () => {
    expect(new FfmpegAudioAnalyzer()).toBeInstanceOf(FfmpegAudioAnalyzer);
  });
});

// gaulatti/alcantara#235: cue rule 2. The loudness line of a stderr decides the tail detector that is read:
// the gain Palazzo plays a song with is min(-16 - LUFS, -1 - true peak) dB, and the tail threshold is the file
// level that is -45 dBFS on air, kept within [-50, -35] dB.
const LOUDNESS = (lufs: number, peak: number) => `Summary:
  I:         ${lufs} LUFS
  Peak:       ${peak} dBFS
`;
const stderrOf = (lines: string[], lufs = -14.2, peak = -0.8) =>
  `${lines.join('\n')}\n${LOUDNESS(lufs, peak)}`;
const loud = (lufs: number, peak: number) => ({
  integratedLufs: lufs,
  truePeakDbtp: peak,
});

describe('the silence detectors of cue rule 2', () => {
  it('reads silence at rule 1, at the head and at every whole dB from -50 to -35 in one chain', () => {
    const chain = silenceFilterChain().split(',');
    expect(chain[0]).toBe('silencedetect@base=noise=-50dB:d=0.5');
    expect(chain[1]).toBe('silencedetect@head=noise=-50dB:d=0.2');
    expect(chain.slice(2, -1)).toEqual(
      Array.from(
        { length: 16 },
        (_, index) =>
          `silencedetect@tail${50 - index}=noise=${-50 + index}dB:d=0.3`,
      ),
    );
    expect(chain[chain.length - 1]).toBe('ebur128=peak=true:framelog=quiet');
    expect(tailFilterName(-43)).toBe('tail43');
  });

  it('reads one detector at a time by its name, and unnamed lines only without one', () => {
    const stderr =
      '[silencedetect@head @ 0x1] silence_start: 0\n[silencedetect@head @ 0x1] silence_end: 0.3\n[silencedetect@base @ 0x2] silence_start: 9\nsilence_start: 5\n[silencedetect @ 0x3] silence_end: 6';
    expect(parseSilence(stderr, 'head')).toEqual([{ start: 0, end: 0.3 }]);
    expect(parseSilence(stderr, 'base')).toEqual([{ start: 9, end: null }]);
    expect(parseSilence(stderr)).toEqual([{ start: 5, end: 6 }]);
    expect(parseSilence(stderr, 'tail40')).toEqual([]);
  });
});

describe('the tail threshold of a song', () => {
  it('is the file level that is -45 dBFS once the playout gain is applied', () => {
    // -8.7 LUFS plays 7.3 dB lower (target -16): -45 on air is -37.7 in the file.
    expect(tailThresholdDb(loud(-8.7, -3))).toBe(-38);
    expect(tailThresholdDb(loud(-14.2, -0.8))).toBe(-43);
    expect(tailThresholdDb(loud(-16, -3))).toBe(-45);
  });

  it('is capped by the true-peak ceiling, because Palazzo gives a song less gain than the target asks', () => {
    // Needs +4 dB to reach -16 but the peak at +1 dBTP allows -2 dB only.
    expect(tailThresholdDb(loud(-20, 1))).toBe(-43);
  });

  it('never goes below -50 for an amplified song, and never above -35', () => {
    expect(tailThresholdDb(loud(-30, -20))).toBe(-50);
    expect(tailThresholdDb(loud(-5, 2))).toBe(-35);
    // A true peak at 0 dBTP allows only -1 dB of gain: -44, not lower.
    expect(tailThresholdDb(loud(-18, 0))).toBe(-44);
  });
});

describe('cue rule 2', () => {
  const D = 240;

  it('takes the short leading run for the head and the loudness-relative run for the tail', () => {
    const stderr = stderrOf([
      '[silencedetect@base @ 0x2] silence_start: 238.0001',
      '[silencedetect@base @ 0x2] silence_end: 240',
      '[silencedetect@head @ 0x3] silence_start: 0',
      '[silencedetect@head @ 0x3] silence_end: 0.31',
      '[silencedetect@tail43 @ 0x4] silence_start: 237.2',
    ]);
    expect(ruleCuePoints(stderr, D, loud(-14.2, -0.8))).toEqual({
      cueInSeconds: 0.31,
      cueOutSeconds: 237.2,
      cueRule: { head: 'applied', tail: 'applied' },
    });
  });

  it('leaves an edge as rule 1 has it when rule 2 finds the same edge, or none', () => {
    const stderr = stderrOf([
      '[silencedetect@base @ 0x2] silence_start: 0',
      '[silencedetect@base @ 0x2] silence_end: 1.5',
      '[silencedetect@head @ 0x3] silence_start: 0',
      '[silencedetect@head @ 0x3] silence_end: 1.5',
      '[silencedetect@base @ 0x2] silence_start: 238',
      '[silencedetect@tail43 @ 0x4] silence_start: 238',
    ]);
    expect(ruleCuePoints(stderr, D, loud(-14.2, -0.8))).toEqual({
      cueInSeconds: 1.5,
      cueOutSeconds: 238,
      cueRule: { head: 'unchanged', tail: 'unchanged' },
    });
    expect(ruleCuePoints(stderrOf([]), D, loud(-14.2, -0.8)).cueRule).toEqual({
      head: 'unchanged',
      tail: 'unchanged',
    });
  });

  it('keeps rule 1 for an edge that would move more than 1.5 s beyond it, and counts it', () => {
    const stderr = stderrOf([
      '[silencedetect@base @ 0x2] silence_start: 0',
      '[silencedetect@base @ 0x2] silence_end: 0.6',
      '[silencedetect@head @ 0x3] silence_start: 0',
      '[silencedetect@head @ 0x3] silence_end: 2.2',
      '[silencedetect@base @ 0x2] silence_start: 238',
      '[silencedetect@tail43 @ 0x4] silence_start: 236.4',
    ]);
    expect(ruleCuePoints(stderr, D, loud(-14.2, -0.8))).toEqual({
      cueInSeconds: 0.6,
      cueOutSeconds: 238,
      cueRule: { head: 'bounded', tail: 'bounded' },
    });
  });

  it('moves an edge by exactly 1.5 s, and a tail that rule 1 did not find against the file end', () => {
    const exact = stderrOf([
      '[silencedetect@base @ 0x2] silence_start: 238',
      '[silencedetect@tail43 @ 0x4] silence_start: 236.5',
      '[silencedetect@head @ 0x3] silence_start: 0',
      '[silencedetect@head @ 0x3] silence_end: 1.5',
    ]);
    expect(ruleCuePoints(exact, D, loud(-14.2, -0.8))).toMatchObject({
      cueInSeconds: 1.5,
      cueOutSeconds: 236.5,
      cueRule: { head: 'applied', tail: 'applied' },
    });
    const noBase = stderrOf([
      '[silencedetect@tail43 @ 0x4] silence_start: 239.2',
    ]);
    expect(ruleCuePoints(noBase, D, loud(-14.2, -0.8))).toMatchObject({
      cueOutSeconds: 239.2,
      cueRule: { tail: 'applied' },
    });
    const tooFar = stderrOf([
      '[silencedetect@tail43 @ 0x4] silence_start: 238.4',
    ]);
    // 1.6 s before the file end with no cue-out from rule 1: beyond the 1.5 s bound.
    expect(ruleCuePoints(tooFar, D, loud(-14.2, -0.8))).toMatchObject({
      cueOutSeconds: null,
      cueRule: { tail: 'bounded' },
    });
  });

  it('ignores a tail run that does not reach the end of the file and a head run that does not start the file', () => {
    const stderr = stderrOf([
      '[silencedetect@head @ 0x3] silence_start: 3',
      '[silencedetect@head @ 0x3] silence_end: 4',
      '[silencedetect@tail43 @ 0x4] silence_start: 100',
      '[silencedetect@tail43 @ 0x4] silence_end: 101',
    ]);
    expect(ruleCuePoints(stderr, D, loud(-14.2, -0.8))).toEqual({
      cueInSeconds: null,
      cueOutSeconds: null,
      cueRule: { head: 'unchanged', tail: 'unchanged' },
    });
  });

  it('keeps rule 1 for a tail that would reach the cue-in', () => {
    const stderr = stderrOf([
      '[silencedetect@base @ 0x2] silence_start: 0',
      '[silencedetect@base @ 0x2] silence_end: 1',
      '[silencedetect@head @ 0x3] silence_start: 0',
      '[silencedetect@head @ 0x3] silence_end: 1',
      '[silencedetect@tail43 @ 0x4] silence_start: 0.9',
    ]);
    expect(ruleCuePoints(stderr, 1.8, loud(-14.2, -0.8))).toMatchObject({
      cueInSeconds: 1,
      cueRule: { head: 'unchanged', tail: 'bounded' },
    });
  });

  it('reads the tail detector the song needs: a loud master at -38', () => {
    const stderr = stderrOf(
      [
        '[silencedetect@tail38 @ 0x4] silence_start: 238.9',
        '[silencedetect@tail43 @ 0x5] silence_start: 239.5',
      ],
      -8.7,
      -3,
    );
    expect(ruleCuePoints(stderr, D, loud(-8.7, -3))).toMatchObject({
      cueOutSeconds: 238.9,
    });
  });

  it('refuses a file that is silent end to end, as rule 1 does', () => {
    const stderr = stderrOf(['[silencedetect@base @ 0x2] silence_start: 0']);
    expect(syncError(() => ruleCuePoints(stderr, D, loud(-14.2, -0.8)))).toBe(
      'silent',
    );
  });

  it('is rule version 2', () => {
    expect(CUE_RULE_VERSION).toBe(2);
  });
});
