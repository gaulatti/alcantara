import type { ProgramService } from '../../program/program.service';
import { MCP_READ_LIMITS } from '../mcp.constants';
import { McpChangeFeed, type McpWaitOutcome } from './mcp-change.feed';

// What the feed keeps from the program event stream, and how waits end.

type Listener = Parameters<ProgramService['addEventListener']>[0];

function setup() {
  let listener: Listener | null = null;
  const detach = jest.fn();
  const programs = {
    addEventListener: jest.fn((l: Listener) => {
      listener = l;
      return detach;
    }),
  };
  const feed = new McpChangeFeed(programs as unknown as ProgramService);
  feed.onModuleInit();
  const emit = (data: unknown, programId: string | null = 'p1') =>
    listener!({ scope: 'program', programId, data });
  return { feed, emit, detach, listener: () => listener! };
}

/** Every kept change of a program, in order: waits until one times out. */
async function drain(feed: McpChangeFeed, programId = 'p1') {
  const kept: Array<{ sequence: number; kind: string }> = [];
  for (let since = 0; ; ) {
    const [outcome] = await Promise.all([
      feed.wait(programId, since, 1_000),
      jest.advanceTimersByTimeAsync(1_000),
    ]);
    if (outcome.outcome !== 'change') return kept;
    kept.push(outcome.change);
    since = outcome.change.sequence;
  }
}

const first = async (feed: McpChangeFeed, since?: number) =>
  feed.wait('p1', since, 1_000);

describe('MCP change feed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps discrete changes from the event stream and ignores the rest', async () => {
    const { feed, emit, listener } = setup();
    emit({
      type: 'playing_track_update',
      playingTrack: { playbackId: 'r1', title: 'T', artist: 'A' },
    });
    emit({ type: 'playing_track_update' });
    emit({ type: 'song_off_air' });
    emit({ type: 'song_queue_update' });
    emit({
      type: 'song_request_failed',
      playbackRequestId: 'r2',
      reason: 'timeout',
      title: 'X',
      artist: 'Y',
    });
    emit({ type: 'flight_update' });
    // Not changes: progress, levels, scenes, junk.
    emit({ type: 'song_playback_update' });
    emit({ type: 'audio_meter_update' });
    emit({ type: 'scene_change' });
    emit(null);
    emit('text');
    emit([1]);
    emit({});
    listener()({
      scope: 'global',
      programId: null,
      data: { type: 'song_off_air' },
    });
    listener()({
      scope: 'program',
      programId: null,
      data: { type: 'song_off_air' },
    });
    const kinds = (await drain(feed)).map((change) => change.kind);
    expect(kinds).toEqual([
      'track_started',
      'track_ended',
      'song_off_air',
      'queue_changed',
      'song_request_failed',
      'rundown_changed',
    ]);
  });

  it('carries only text a producer sent as text', async () => {
    const { feed, emit } = setup();
    emit({
      type: 'playing_track_update',
      playingTrack: { playbackId: 7, title: 8, artist: null },
    });
    emit({
      type: 'song_request_failed',
      playbackRequestId: 1,
      reason: 2,
      title: 3,
      artist: 4,
    });
    const a = (await first(feed, 0)) as Extract<
      McpWaitOutcome,
      { outcome: 'change' }
    >;
    expect(a.change).toMatchObject({
      kind: 'track_started',
      playbackRequestId: undefined,
      untrusted: { title: null, artist: null },
    });
    const b = (await first(feed, 1)) as Extract<
      McpWaitOutcome,
      { outcome: 'change' }
    >;
    expect(b.change).toMatchObject({
      kind: 'song_request_failed',
      playbackRequestId: undefined,
      reason: undefined,
      untrusted: { title: null, artist: null },
    });
  });

  it('numbers changes per program from one and drops repeated Palazzo status', async () => {
    const { feed, emit } = setup();
    const status = (connection: string, degraded: boolean) =>
      emit({ type: 'radio_leg_status', status: { connection, degraded } });
    status('connected', false);
    status('connected', false);
    status('unavailable', true);
    status('unavailable', true);
    emit({ type: 'radio_leg_status' });
    emit({ type: 'song_off_air' }, 'p2');
    const seen = (await drain(feed)).map((change) => change.sequence);
    expect(seen).toEqual([1, 2, 3]);
    const other = await feed.wait('p2', 0, 1_000);
    expect(other).toMatchObject({
      outcome: 'change',
      change: { sequence: 1, kind: 'song_off_air' },
    });
  });

  it('answers at once from the kept changes, and says when older ones were dropped', async () => {
    const { feed, emit } = setup();
    const total = MCP_READ_LIMITS.changeBuffer + 2;
    for (let i = 0; i < total; i += 1) emit({ type: 'song_queue_update' });
    const oldest = await feed.wait('p1', 0, 1_000);
    expect(oldest).toMatchObject({
      outcome: 'change',
      change: { sequence: 3 },
      missed: true,
    });
    const exact = await feed.wait('p1', 2, 1_000);
    expect(exact).toMatchObject({
      outcome: 'change',
      change: { sequence: 3 },
      missed: false,
    });
    const next = await feed.wait('p1', total - 1, 1_000);
    expect(next).toMatchObject({
      outcome: 'change',
      change: { sequence: total },
      missed: false,
    });
  });

  it('says reset for a sequence ahead of the log, and timeout when nothing changes', async () => {
    const { feed } = setup();
    expect(await feed.wait('p1', 5, 1_000)).toEqual({
      outcome: 'reset',
      sequence: 0,
    });
    const pending = feed.wait('p1', undefined, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ outcome: 'timeout', sequence: 0 });
  });

  it('wakes every waiter on the next change and leaves none behind', async () => {
    const { feed, emit } = setup();
    const a = feed.wait('p1', undefined, 30_000);
    const b = feed.wait('p1', 0, 30_000);
    emit({ type: 'song_off_air' });
    expect(await a).toMatchObject({ outcome: 'change', missed: false });
    expect(await b).toMatchObject({ outcome: 'change', missed: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops listening on destroy and ends waits as timeouts', async () => {
    const { feed, emit, detach } = setup();
    emit({ type: 'song_off_air' });
    const waiting = feed.wait('p1', undefined, 30_000);
    feed.onModuleDestroy();
    expect(await waiting).toEqual({ outcome: 'timeout', sequence: 1 });
    expect(detach).toHaveBeenCalledTimes(1);
    feed.onModuleDestroy();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
