import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AudioAnalysisError,
  FfmpegAudioAnalyzer,
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
