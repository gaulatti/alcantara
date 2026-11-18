import {
  validateSongLoudness,
  validateSongSegue,
} from '../radio/palazzo-machine.client';
import {
  checkedAddress,
  OutboundRefusal,
  type OutboundFetchPath,
  type OutboundFetchResult,
  type ResolveAll,
} from '../outbound/safe-fetch';
import {
  createProcessRunner,
  ProcessRunError,
  type ProcessRunner,
} from './process-runner';

/** Below this level, held for at least SILENCE_MIN_SECONDS, audio is silence. */
export const SILENCE_THRESHOLD_DB = -50;
export const SILENCE_MIN_SECONDS = 0.5;
/** A silence this close to the start or the end of the file touches that edge. */
export const EDGE_TOLERANCE_SECONDS = 0.05;
/** Output kept from one tool run; anything larger is treated as a failure. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How long one network read may stall, in microseconds (ffmpeg's unit). */
const READ_TIMEOUT_MICROSECONDS = '30000000';

export type AnalysisErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'output-limit'
  | 'probe-failed'
  | 'decode-failed'
  | 'no-audio'
  | 'silent'
  | 'invalid-measurement'
  | 'source-refused'
  | 'source-unresolved';

/** Codes that a second run of the same file cannot change. */
const PERMANENT_ERRORS = new Set<AnalysisErrorCode>([
  'no-audio',
  'silent',
  'invalid-measurement',
  'source-refused',
]);

export class AudioAnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(`Audio analysis failed: ${code}`);
  }

  get retryable(): boolean {
    return !PERMANENT_ERRORS.has(this.code);
  }
}

export interface AudioAnalysis {
  durationSeconds: number;
  cueInSeconds: number | null;
  cueOutSeconds: number | null;
  integratedLufs: number;
  truePeakDbtp: number;
  isrc: string | null;
  musicbrainzRecordingId: string | null;
}

export interface SilencePeriod {
  start: number;
  end: number | null;
}

const ISRC_TAGS = ['isrc', 'tsrc'];
const MUSICBRAINZ_RECORDING_TAGS = [
  'musicbrainz_trackid',
  'musicbrainz track id',
  'musicbrainz_recordingid',
  'musicbrainz recording id',
];

function seconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRemote(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function protocolWhitelist(input: string): string {
  return isRemote(input) ? 'http,https,tcp,tls,crypto' : 'file';
}

/** A remote input is read only from the checked URL: no redirect is followed. */
function redirectArguments(input: string): string[] {
  return isRemote(input) ? ['-max_redirects', '0'] : [];
}

/** How a remote input is checked before a tool reads it (real DNS by default). */
export interface RemoteInputPolicy {
  resolve?: ResolveAll;
  record?: (path: OutboundFetchPath, result: OutboundFetchResult) => void;
}

export function probeArguments(input: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    protocolWhitelist(input),
    '-rw_timeout',
    READ_TIMEOUT_MICROSECONDS,
    ...redirectArguments(input),
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_type:stream_tags:format_tags',
    '-of',
    'json',
    input,
  ];
}

export function measureArguments(input: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-threads',
    '1',
    '-protocol_whitelist',
    protocolWhitelist(input),
    '-rw_timeout',
    READ_TIMEOUT_MICROSECONDS,
    ...redirectArguments(input),
    '-progress',
    'pipe:1',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_SECONDS},ebur128=peak=true:framelog=quiet`,
    '-f',
    'null',
    '-',
  ];
}

function tagValue(tags: Map<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = tags.get(key);
    if (value !== undefined) return value;
  }
  return null;
}

export function normalizeIsrc(value: string | null): string | null {
  if (value === null) return null;
  const isrc = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null;
}

export function normalizeMusicbrainzId(value: string | null): string | null {
  if (value === null) return null;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    id,
  )
    ? id
    : null;
}

/** Reads the first audio stream's presence and the identifiers in its tags. */
export function parseProbe(output: string): {
  isrc: string | null;
  musicbrainzRecordingId: string | null;
} {
  let probe: {
    streams?: Array<{ tags?: Record<string, unknown> }>;
    format?: { tags?: Record<string, unknown> };
  };
  try {
    probe = JSON.parse(output) as typeof probe;
  } catch {
    throw new AudioAnalysisError('probe-failed');
  }
  if (!probe || typeof probe !== 'object') {
    throw new AudioAnalysisError('probe-failed');
  }
  const stream = Array.isArray(probe.streams) ? probe.streams[0] : undefined;
  if (!stream) throw new AudioAnalysisError('no-audio');

  const tags = new Map<string, string>();
  for (const source of [probe.format?.tags, stream.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      const name = key.toLowerCase();
      if (typeof value === 'string' && !tags.has(name)) tags.set(name, value);
    }
  }
  return {
    isrc: normalizeIsrc(tagValue(tags, ISRC_TAGS)),
    musicbrainzRecordingId: normalizeMusicbrainzId(
      tagValue(tags, MUSICBRAINZ_RECORDING_TAGS),
    ),
  };
}

export function parseSilence(stderr: string): SilencePeriod[] {
  const periods: SilencePeriod[] = [];
  for (const match of stderr.matchAll(
    /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g,
  )) {
    const value = Number(match[2]);
    if (match[1] === 'start') {
      periods.push({ start: value, end: null });
    } else if (periods.length && periods[periods.length - 1].end === null) {
      periods[periods.length - 1].end = value;
    }
  }
  return periods;
}

/** Integrated loudness and true peak from the ebur128 summary. */
export function parseLoudness(stderr: string): {
  integratedLufs: number;
  truePeakDbtp: number;
} {
  const start = stderr.lastIndexOf('Summary:');
  const summary = start < 0 ? '' : stderr.slice(start);
  const integrated = /\bI:\s+(\S+)\s+LUFS/.exec(summary);
  const peak = /\bPeak:\s+(\S+)\s+dBFS/.exec(summary);
  if (!integrated || !peak) {
    throw new AudioAnalysisError('invalid-measurement');
  }
  return {
    integratedLufs: Number(integrated[1]),
    truePeakDbtp: Number(peak[1]),
  };
}

/** The decoded length, from the last progress report. */
export function parseDecodedDuration(stdout: string): number {
  const reports = [...stdout.matchAll(/out_time_us=(\d+)/g)];
  const last = reports[reports.length - 1];
  const duration = last ? Number(last[1]) / 1_000_000 : 0;
  if (!(duration > 0)) throw new AudioAnalysisError('decode-failed');
  return duration;
}

/**
 * Cue-in is the end of a silence that starts the file; cue-out is the start
 * of a silence that ends it. An edge without silence gets no cue point.
 */
export function cuePoints(
  periods: SilencePeriod[],
  durationSeconds: number,
): { cueInSeconds: number | null; cueOutSeconds: number | null } {
  const first = periods[0];
  const last = periods[periods.length - 1];
  const leading = first !== undefined && first.start <= EDGE_TOLERANCE_SECONDS;
  const trailing =
    last !== undefined &&
    (last.end === null || last.end >= durationSeconds - EDGE_TOLERANCE_SECONDS);
  if (leading && trailing && first === last) {
    throw new AudioAnalysisError('silent');
  }
  return {
    cueInSeconds: leading ? seconds(first.end!) : null,
    cueOutSeconds: trailing ? seconds(last.start) : null,
  };
}

/**
 * The values are checked with the same functions the Palazzo client applies
 * to a song command, so a stored success can always be sent. A missing cue is
 * checked as the file's own edge.
 */
export function assertPlayable(analysis: AudioAnalysis): void {
  try {
    validateSongSegue(
      {
        cueInSeconds: analysis.cueInSeconds ?? 0,
        cueOutSeconds: analysis.cueOutSeconds ?? analysis.durationSeconds,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        overlapSeconds: 0,
      },
      analysis.durationSeconds,
    );
    validateSongLoudness({
      integratedLufs: analysis.integratedLufs,
      truePeakDbtp: analysis.truePeakDbtp,
    });
  } catch {
    throw new AudioAnalysisError('invalid-measurement');
  }
}

/** Scheduling priority for the tools when `nice` is installed (19 is lowest). */
export const NICE_LEVEL = '19';

export class FfmpegAudioAnalyzer {
  private niced = false;

  constructor(
    private readonly run: ProcessRunner = createProcessRunner(),
    private readonly policy: RemoteInputPolicy = {},
  ) {}

  /** Whether the tools run at lowered priority; known after available(). */
  get lowPriority(): boolean {
    return this.niced;
  }

  /**
   * True when both tools start; checked once before the job is scheduled.
   * It also checks whether `nice` can start them, and from then on runs every
   * tool through it so analysis yields the CPU to the radio.
   */
  async available(timeoutMs: number): Promise<boolean> {
    const options = { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES };
    try {
      for (const tool of ['ffprobe', 'ffmpeg']) {
        await this.run(tool, ['-hide_banner', '-version'], options);
      }
    } catch {
      return false;
    }
    try {
      await this.run(
        'nice',
        ['-n', NICE_LEVEL, 'ffprobe', '-hide_banner', '-version'],
        options,
      );
      this.niced = true;
    } catch {
      this.niced = false;
    }
    return true;
  }

  async analyze(input: string, timeoutMs: number): Promise<AudioAnalysis> {
    const deadline = Date.now() + timeoutMs;
    if (isRemote(input)) await this.checkRemoteInput(input, deadline);
    const probe = await this.runTool(
      'ffprobe',
      probeArguments(input),
      deadline,
      'probe-failed',
    );
    const identifiers = parseProbe(probe.stdout);
    const measure = await this.runTool(
      'ffmpeg',
      measureArguments(input),
      deadline,
      'decode-failed',
    );
    const durationSeconds = parseDecodedDuration(measure.stdout);
    const analysis: AudioAnalysis = {
      durationSeconds,
      ...cuePoints(parseSilence(measure.stderr), durationSeconds),
      ...parseLoudness(measure.stderr),
      ...identifiers,
    };
    assertPlayable(analysis);
    return analysis;
  }

  /**
   * The outbound-request policy for a remote input: the URL must parse with
   * no user name or password, and every address its host resolves to must be
   * public. ffmpeg then resolves the name again itself and follows no
   * redirect. A refusal names no URL; it is counted under media_analysis.
   */
  private async checkRemoteInput(input: string, deadline: number) {
    const record = (result: OutboundFetchResult) =>
      this.policy.record?.('media_analysis', result);
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      record('invalid_url');
      throw new AudioAnalysisError('source-refused');
    }
    if (url.username || url.password) {
      record('invalid_url');
      throw new AudioAnalysisError('source-refused');
    }
    const remaining = deadline - Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        checkedAddress(url.hostname, this.policy.resolve),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new OutboundRefusal('timeout')),
            Math.max(0, remaining),
          );
        }),
      ]);
    } catch (error) {
      // checkedAddress only throws an OutboundRefusal (address or dns).
      const { reason } = error as OutboundRefusal;
      record(reason);
      if (reason === 'timeout') throw new AudioAnalysisError('timeout');
      throw new AudioAnalysisError(
        reason === 'dns' ? 'source-unresolved' : 'source-refused',
      );
    } finally {
      clearTimeout(timer);
    }
    record(url.protocol === 'http:' ? 'legacy_http' : 'ok');
  }

  private async runTool(
    command: string,
    args: string[],
    deadline: number,
    exitCode: AnalysisErrorCode,
  ) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new AudioAnalysisError('timeout');
    try {
      const [program, programArgs] = this.niced
        ? ['nice', ['-n', NICE_LEVEL, command, ...args]]
        : [command, args];
      return await this.run(program, programArgs, {
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const failure = (error as ProcessRunError).failure;
      if (failure === 'spawn') throw new AudioAnalysisError('unavailable');
      if (failure === 'timeout') throw new AudioAnalysisError('timeout');
      if (failure === 'output-limit') {
        throw new AudioAnalysisError('output-limit');
      }
      throw new AudioAnalysisError(exitCode);
    }
  }
}
