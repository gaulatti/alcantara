import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateSongLoudness,
  validateSongSegue,
} from '../radio/palazzo-machine.client';
import { isAudioMediaType } from '../outbound/media-types';
import {
  safeFetch,
  type OutboundRefusal,
  type OutboundFetchPath,
  type OutboundFetchResult,
  type ResolveAll,
  type SafeFetchDeps,
} from '../outbound/safe-fetch';
import {
  createProcessRunner,
  ProcessRunError,
  type ProcessRunner,
} from './process-runner';

/** Below this level, held for at least SILENCE_MIN_SECONDS, audio is silence. */
export const SILENCE_THRESHOLD_DB = -50;
export const SILENCE_MIN_SECONDS = 0.5;
/**
 * Cue rule 2 (gaulatti/alcantara#235). The head is the leading run below the same -50 dB held for at least
 * HEAD_SILENCE_MIN_SECONDS. The tail is the trailing run below a threshold that follows how loud the song is on
 * air, held for at least TAIL_SILENCE_MIN_SECONDS: the audio below TAIL_AIR_FLOOR_DB once Palazzo's loudness gain
 * is applied is the quiet stretch heard before every change, so it is cut. The threshold is kept within
 * [TAIL_THRESHOLD_MIN_DB, TAIL_THRESHOLD_MAX_DB], and a cue is moved by at most MAX_EXTRA_TRIM_SECONDS beyond the
 * cue rule 1 would give (otherwise rule 1's cue is kept).
 */
export const CUE_RULE_VERSION = 3;
/** Rule 2 (C): a tail beyond the bound keeps rule 1's edge. Rule 3 (C2) cuts exactly MAX_EXTRA_TRIM_SECONDS past it instead. */
export const BOUND_KEEPS_RULE_VERSION = 2;
/** The rule before #235 (the `base` detector alone), kept selectable per request so a batch can be re-run on it. */
export const PREVIOUS_CUE_RULE_VERSION = 1;
export const HEAD_SILENCE_MIN_SECONDS = 0.2;
export const TAIL_SILENCE_MIN_SECONDS = 0.3;
export const TAIL_AIR_FLOOR_DB = -45;
export const TAIL_THRESHOLD_MIN_DB = -50;
export const TAIL_THRESHOLD_MAX_DB = -35;
export const MAX_EXTRA_TRIM_SECONDS = 1.5;
/**
 * Palazzo's playout loudness (gaulatti/palazzo, src/stream/stream.service.ts:372-385; docs/program-playout.md:142-148):
 * the song is played with gain min(target - integrated LUFS, ceiling - true peak) dB. These are Palazzo's defaults;
 * keep them in step with its PLAYOUT_TARGET_LUFS and PLAYOUT_TRUE_PEAK_CEILING_DBTP.
 */
export const PLAYOUT_TARGET_LUFS = -16;
export const PLAYOUT_TRUE_PEAK_CEILING_DBTP = -1;
/** A silence this close to the start or the end of the file touches that edge. */
export const EDGE_TOLERANCE_SECONDS = 0.05;
/** Output kept from one tool run; anything larger is treated as a failure. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** The largest remote input read: the upload limit (main.ts). */
export const MAX_INPUT_BYTES = 200 * 1024 * 1024;
/**
 * The only request header sent for a remote input. ffmpeg always sent its own
 * user agent, and some media hosts refuse a request without one.
 */
export const INPUT_USER_AGENT = 'alcantara-media-analysis';
/** Prefix of the private directory that holds one remote input. */
export const INPUT_DIRECTORY_PREFIX = 'alcantara-analysis-';

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
  | 'source-unresolved'
  | 'source-unavailable';

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
  /** The cue rule that placed the cue points (CUE_RULE_VERSION). */
  ruleVersion: number;
  /** What rule 2 did to each edge, for the analysis metric: never stored. */
  cueRule: CueRuleOutcome;
}

/** applied: the edge moved from rule 1's; unchanged: the same; bounded: it would move too far, rule 1's edge is kept; clamped: it would move too far, so it moved exactly the bound (rule 3). */
export type EdgeOutcome = 'applied' | 'unchanged' | 'bounded' | 'clamped';
export interface CueRuleOutcome {
  head: EdgeOutcome;
  tail: EdgeOutcome;
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

/** The tools only ever open a local file. */
const PROTOCOL_WHITELIST = 'file';

/**
 * How a remote input is fetched before a tool reads it: real DNS, the
 * network and the OS temporary directory by default.
 */
export interface RemoteInputPolicy {
  resolve?: ResolveAll;
  request?: SafeFetchDeps['request'];
  record?: (path: OutboundFetchPath, result: OutboundFetchResult) => void;
  tempRoot?: string;
}

export function probeArguments(input: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_type:stream_tags:format_tags',
    '-of',
    'json',
    input,
  ];
}

/**
 * One pass reads the song's silence at every threshold the cue rule may need, because the tail threshold depends on
 * the loudness, which the same pass measures: the rule-1 detector (today's cue, the bound), the head detector and one
 * tail detector per whole dB from TAIL_THRESHOLD_MIN_DB to TAIL_THRESHOLD_MAX_DB, then the loudness.
 */
export function silenceFilterChain(): string {
  const filters = [
    `silencedetect@base=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_SECONDS}`,
    `silencedetect@head=noise=${SILENCE_THRESHOLD_DB}dB:d=${HEAD_SILENCE_MIN_SECONDS}`,
  ];
  for (let db = TAIL_THRESHOLD_MIN_DB; db <= TAIL_THRESHOLD_MAX_DB; db += 1) {
    filters.push(
      `silencedetect@${tailFilterName(db)}=noise=${db}dB:d=${TAIL_SILENCE_MIN_SECONDS}`,
    );
  }
  filters.push('ebur128=peak=true:framelog=quiet');
  return filters.join(',');
}

/** The instance name of the tail detector for a threshold in whole dB (negative). */
export function tailFilterName(db: number): string {
  return `tail${Math.abs(db)}`;
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
    PROTOCOL_WHITELIST,
    '-progress',
    'pipe:1',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    silenceFilterChain(),
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

/**
 * The silence periods one detector logged. `filter` is the detector's instance name (`silencedetect@name`); without
 * one, the unnamed detector's lines are read.
 */
export function parseSilence(stderr: string, filter?: string): SilencePeriod[] {
  const periods: SilencePeriod[] = [];
  const name = filter === undefined ? '' : `@${filter}`;
  for (const match of stderr.matchAll(
    /(?:\[silencedetect(@\w+)? @ [^\]]*\]\s*)?silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g,
  )) {
    if ((match[1] ?? '') !== name) continue;
    const value = Number(match[3]);
    if (match[2] === 'start') {
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
 * The tail threshold, in whole dB, for a song: where the song is quieter than TAIL_AIR_FLOOR_DB once Palazzo's
 * loudness gain is applied. A loud master is played lower, so its file level for the same on-air level is higher;
 * a quiet master that is amplified gets the lowest threshold, which is rule 1's.
 */
export function tailThresholdDb(loudness: {
  integratedLufs: number;
  truePeakDbtp: number;
}): number {
  const gainDb = Math.min(
    PLAYOUT_TARGET_LUFS - loudness.integratedLufs,
    PLAYOUT_TRUE_PEAK_CEILING_DBTP - loudness.truePeakDbtp,
  );
  return Math.max(
    TAIL_THRESHOLD_MIN_DB,
    Math.min(TAIL_THRESHOLD_MAX_DB, Math.round(TAIL_AIR_FLOOR_DB - gainDb)),
  );
}

/**
 * Cue rule 2 (gaulatti/alcantara#235): rule 1's cue points (the `base` detector) are the reference; the head uses
 * the shorter leading run, the tail the loudness-relative threshold. An edge that would move more than
 * MAX_EXTRA_TRIM_SECONDS beyond rule 1's keeps rule 1's, and so does a tail that would reach the cue-in.
 */
export function ruleCuePoints(
  stderr: string,
  durationSeconds: number,
  loudness: { integratedLufs: number; truePeakDbtp: number },
  rule: number = CUE_RULE_VERSION,
): {
  cueInSeconds: number | null;
  cueOutSeconds: number | null;
  cueRule: CueRuleOutcome;
} {
  const base = cuePoints(parseSilence(stderr, 'base'), durationSeconds);

  const heads = parseSilence(stderr, 'head');
  const firstHead = heads[0];
  const headEnd =
    firstHead !== undefined &&
    firstHead.start <= EDGE_TOLERANCE_SECONDS &&
    firstHead.end !== null
      ? seconds(firstHead.end)
      : null;
  let cueInSeconds = base.cueInSeconds;
  let head: EdgeOutcome = 'unchanged';
  if (headEnd !== null && headEnd !== base.cueInSeconds) {
    if (headEnd - (base.cueInSeconds ?? 0) > MAX_EXTRA_TRIM_SECONDS) {
      head = 'bounded';
    } else {
      cueInSeconds = headEnd;
      head = 'applied';
    }
  }

  const tails = parseSilence(stderr, tailFilterName(tailThresholdDb(loudness)));
  const lastTail = tails[tails.length - 1];
  const tailStart =
    lastTail !== undefined &&
    (lastTail.end === null ||
      lastTail.end >= durationSeconds - EDGE_TOLERANCE_SECONDS)
      ? seconds(lastTail.start)
      : null;
  let cueOutSeconds = base.cueOutSeconds;
  let tail: EdgeOutcome = 'unchanged';
  if (tailStart !== null && tailStart !== base.cueOutSeconds) {
    const edge = base.cueOutSeconds ?? durationSeconds;
    if (tailStart <= (cueInSeconds ?? 0)) {
      tail = 'bounded';
    } else if (edge - tailStart > MAX_EXTRA_TRIM_SECONDS) {
      // Everything from tailStart on is below the on-air floor, so cutting the bound past rule 1's edge (still inside
      // that stretch) removes only quiet. Rule 2 kept rule 1's edge here; rule 3 clamps.
      const clamped = seconds(edge - MAX_EXTRA_TRIM_SECONDS);
      if (rule > BOUND_KEEPS_RULE_VERSION && clamped > (cueInSeconds ?? 0)) {
        cueOutSeconds = clamped;
        tail = 'clamped';
      } else {
        tail = 'bounded';
      }
    } else {
      cueOutSeconds = tailStart;
      tail = 'applied';
    }
  }
  return { cueInSeconds, cueOutSeconds, cueRule: { head, tail } };
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

function sourceError(reason: OutboundRefusal['reason']): AudioAnalysisError {
  if (reason === 'timeout') return new AudioAnalysisError('timeout');
  if (reason === 'dns') return new AudioAnalysisError('source-unresolved');
  if (reason === 'network' || reason === 'http_status') {
    return new AudioAnalysisError('source-unavailable');
  }
  return new AudioAnalysisError('source-refused');
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

  /**
   * A remote input is fetched through the outbound-request policy into a
   * private temporary file, and the tools read only that file, so the address
   * that was checked is the address that was read. The file is removed on
   * every path.
   */
  async analyze(
    input: string,
    timeoutMs: number,
    rule: number = CUE_RULE_VERSION,
  ): Promise<AudioAnalysis> {
    const deadline = Date.now() + timeoutMs;
    if (!isRemote(input)) return this.measure(input, deadline, rule);
    const directory = await mkdtemp(
      join(this.policy.tempRoot ?? tmpdir(), INPUT_DIRECTORY_PREFIX),
    );
    try {
      const file = join(directory, 'input');
      await this.download(input, file, deadline);
      return await this.measure(file, deadline, rule);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async measure(input: string, deadline: number, rule: number) {
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
    const loudness = parseLoudness(measure.stderr);
    // Rule 1 is the `base` detector alone (PREVIOUS_CUE_RULE_VERSION): a way back that needs no deploy.
    const cues =
      rule === PREVIOUS_CUE_RULE_VERSION
        ? {
            ...cuePoints(parseSilence(measure.stderr, 'base'), durationSeconds),
            cueRule: { head: 'unchanged', tail: 'unchanged' } as CueRuleOutcome,
          }
        : ruleCuePoints(measure.stderr, durationSeconds, loudness, rule);
    const analysis: AudioAnalysis = {
      durationSeconds,
      ...cues,
      ...loudness,
      ...identifiers,
      ruleVersion: rule,
    };
    assertPlayable(analysis);
    return analysis;
  }

  /**
   * The outbound-request policy for a remote input: no user name or
   * password, every address public, the socket pinned to the checked
   * address, no redirect, an audio content type, at most MAX_INPUT_BYTES,
   * all within the file's deadline. A refusal names no URL; it is counted
   * under media_analysis.
   */
  private async download(input: string, file: string, deadline: number) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new AudioAnalysisError('timeout');
    const sink = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    // The file is removed only after the stream has closed it, so a late open
    // never recreates it.
    const closed = new Promise<void>((resolve) =>
      sink.once('close', () => resolve()),
    );
    try {
      await safeFetch(
        input,
        {
          path: 'media_analysis',
          headers: { 'user-agent': INPUT_USER_AGENT },
          maxBytes: MAX_INPUT_BYTES,
          timeoutMs,
          maxRedirects: 0,
          allowContentType: isAudioMediaType,
          allowLegacyHttp: true,
          bodySink: sink,
        },
        {
          resolve: this.policy.resolve,
          request: this.policy.request,
          record: this.policy.record,
        },
      );
    } catch (error) {
      sink.destroy();
      // safeFetch only ever throws an OutboundRefusal.
      throw sourceError((error as OutboundRefusal).reason);
    } finally {
      await closed;
    }
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
