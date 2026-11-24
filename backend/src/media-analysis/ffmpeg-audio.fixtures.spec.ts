import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AudioAnalysisError,
  CUE_RULE_VERSION,
  FfmpegAudioAnalyzer,
  tailThresholdDb,
} from './ffmpeg-audio.analyzer';

// Runs the real ffmpeg and ffprobe on generated fixtures and compares the
// analyzer with a separate reference run of the same tool. Skipped where the
// tools are not installed; the process boundary is covered by stubs elsewhere.
const toolsInstalled = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version']).status === 0,
);
const describeWithTools = toolsInstalled ? describe : describe.skip;

function ffmpeg(args: string[]): string {
  const result = spawnSync(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-y', ...args],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stderr;
}

function reference(path: string): { integrated: number; truePeak: number } {
  const stderr = ffmpeg([
    '-i',
    path,
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  return {
    integrated: Number(/I:\s+(\S+) LUFS/.exec(summary)![1]),
    truePeak: Number(/Peak:\s+(\S+) dBFS/.exec(summary)![1]),
  };
}

/** The last silence start the real ffmpeg finds in a file, for a threshold and a minimum length. */
function lastSilenceStart(
  path: string,
  thresholdDb: number,
  minSeconds: number,
): number {
  const stderr = ffmpeg([
    '-i',
    path,
    '-af',
    `silencedetect=noise=${thresholdDb}dB:d=${minSeconds}`,
    '-f',
    'null',
    '-',
  ]);
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)];
  return Number(starts[starts.length - 1][1]);
}

const tone = (seconds: number) =>
  `sine=f=440:r=44100:d=${seconds},volume=4,aformat=channel_layouts=stereo`;
const noise = (seconds: number) =>
  `anoisesrc=c=pink:r=44100:a=0.3:d=${seconds},aformat=channel_layouts=stereo`;
const silence = (seconds: number) => `anullsrc=r=44100:cl=stereo:d=${seconds}`;

describeWithTools('FfmpegAudioAnalyzer on fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'media-analysis-'));
  const analyzer = new FfmpegAudioAnalyzer();
  const padded = join(directory, 'padded.mp3');
  const continuous = join(directory, 'continuous.flac');
  const silent = join(directory, 'silent.wav');
  const fading = join(directory, 'fading.wav');
  const softLead = join(directory, 'soft-lead.wav');

  beforeAll(() => {
    // 2 s silence, 6 s tone, 3 s silence.
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      silence(2),
      '-f',
      'lavfi',
      '-i',
      tone(6),
      '-f',
      'lavfi',
      '-i',
      silence(3),
      '-filter_complex',
      '[0][1][2]concat=n=3:v=0:a=1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      '-metadata',
      'TSRC=USRC17607839',
      '-metadata',
      'MusicBrainz Track Id=f5093c06-23e3-404f-aeaa-40f72885ee3a',
      padded,
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      noise(8),
      '-metadata',
      'ISRC=GB-AAA-26-00001',
      continuous,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', silence(4), silent]);
    // A loud 12 s tone (about -11 LUFS, so it plays 5 dB lower) that fades by 12 dB per second after 4 s: its
    // level crosses -50 dBFS near 7.5 s and keeps falling to the file's end, the long natural fade rule 2 trims (gaulatti/alcantara#235).
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      "sine=f=440:r=44100:d=12,aformat=channel_layouts=stereo,volume=volume='3.2*pow(10,-max(t-4,0)*12/20)':eval=frame",
      '-c:a',
      'pcm_s16le',
      fading,
    ]);
    // 0.3 s of a tone 60 dB down, then a full-level tone: a quiet lead shorter than rule 1's 0.5 s.
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:r=44100:d=0.3,aformat=channel_layouts=stereo,volume=0.001',
      '-f',
      'lavfi',
      '-i',
      tone(8),
      '-filter_complex',
      '[0][1]concat=n=2:v=0:a=1',
      '-c:a',
      'pcm_s16le',
      softLead,
    ]);
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('measures loudness within 0.5 LU and true peak within 0.3 dB of a reference run', async () => {
    for (const path of [padded, continuous]) {
      const analysis = await analyzer.analyze(path, 60_000);
      const expected = reference(path);
      expect(
        Math.abs(analysis.integratedLufs - expected.integrated),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(analysis.truePeakDbtp - expected.truePeak),
      ).toBeLessThanOrEqual(0.3);
    }
  });

  it('finds cue-in and cue-out around leading and trailing silence', async () => {
    const analysis = await analyzer.analyze(padded, 60_000);
    expect(analysis.durationSeconds).toBeCloseTo(11, 1);
    expect(analysis.cueInSeconds).toBeGreaterThan(1.9);
    expect(analysis.cueInSeconds).toBeLessThan(2.1);
    expect(analysis.cueOutSeconds).toBeGreaterThan(7.9);
    expect(analysis.cueOutSeconds).toBeLessThan(8.1);
    expect(analysis.isrc).toBe('USRC17607839');
    expect(analysis.musicbrainzRecordingId).toBe(
      'f5093c06-23e3-404f-aeaa-40f72885ee3a',
    );
  });

  it('cuts the tail of a long natural fade where the song is quieter than -45 dBFS on air, within the 1.5 s bound', async () => {
    const analysis = await analyzer.analyze(fading, 60_000);
    expect(analysis.ruleVersion).toBe(CUE_RULE_VERSION);
    const threshold = tailThresholdDb(analysis);
    const ruleOne = lastSilenceStart(fading, -50, 0.5);
    const rule = lastSilenceStart(fading, threshold, 0.3);
    expect(rule).toBeLessThan(ruleOne);
    expect(ruleOne - rule).toBeLessThanOrEqual(1.5);
    expect(analysis.cueRule.tail).toBe('applied');
    expect(analysis.cueOutSeconds!).toBeCloseTo(rule, 1);
    expect(analysis.cueOutSeconds!).toBeLessThan(ruleOne);
    // The audio that is kept is never below the threshold: the level just before the cue is above it.
    const kept = ffmpeg([
      '-i',
      fading,
      '-af',
      `atrim=start=${analysis.cueOutSeconds! - 0.1}:end=${analysis.cueOutSeconds!},astats=measure_perchannel=none:measure_overall=Peak_level`,
      '-f',
      'null',
      '-',
    ]);
    const peaks = [...kept.matchAll(/Peak level dB:\s*(-?[\d.]+)/g)];
    expect(Number(peaks[peaks.length - 1][1])).toBeGreaterThan(threshold - 1);
  });

  it('trims a quiet lead shorter than 0.5 s that rule 1 left, and says so', async () => {
    const analysis = await analyzer.analyze(softLead, 60_000);
    expect(analysis.cueInSeconds!).toBeGreaterThan(0.25);
    expect(analysis.cueInSeconds!).toBeLessThan(0.4);
    expect(analysis.cueRule.head).toBe('applied');
  });

  it('invents no cue points for continuous audio', async () => {
    const analysis = await analyzer.analyze(continuous, 60_000);
    expect(analysis.cueInSeconds).toBeNull();
    expect(analysis.cueOutSeconds).toBeNull();
    expect(analysis.isrc).toBe('GBAAA2600001');
    expect(analysis.musicbrainzRecordingId).toBeNull();
  });

  it('fails a silent file and a file that is not audio', async () => {
    await expect(analyzer.analyze(silent, 60_000)).rejects.toEqual(
      new AudioAnalysisError('silent'),
    );
    await expect(
      analyzer.analyze(join(directory, 'missing.mp3'), 60_000),
    ).rejects.toEqual(new AudioAnalysisError('probe-failed'));
  });
});
