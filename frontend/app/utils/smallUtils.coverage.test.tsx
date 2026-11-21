import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClockParts, getOverrideClockParts } from './broadcastTime';
import { songRequestFailureNotice } from './songRequestFailure';
import { acceptStageSceneResponse } from './stageSceneResponse';

describe('song request failure notice', () => {
  it('ignores anything that is not a song_request_failed event', () => {
    expect(songRequestFailureNotice(null)).toBeNull();
    expect(songRequestFailureNotice('song_request_failed')).toBeNull();
    expect(songRequestFailureNotice({ type: 'track_started' })).toBeNull();
  });

  it('names the song and artist and says why it did not play', () => {
    expect(songRequestFailureNotice({ type: 'song_request_failed', title: ' Volare ', artist: ' Modugno ', reason: 'timeout' })).toBe(
      '“Volare” by Modugno did not play: it took too long to load. The next song played instead.',
    );
  });

  it('falls back to "A song" and no artist when they are missing or blank', () => {
    expect(songRequestFailureNotice({ type: 'song_request_failed', title: '  ', artist: 7, reason: 'missing' })).toBe(
      '“A song” did not play: it could not be loaded. The next song played instead.',
    );
  });
});

describe('staged scene response', () => {
  it('returns nothing when the control update was not accepted', () => {
    expect(acceptStageSceneResponse({ stagedSceneId: 1 }, () => false)).toBeNull();
  });

  it('keeps a finite numeric id and an object scene, and nulls anything else', () => {
    const accept = vi.fn(() => true);
    expect(acceptStageSceneResponse({ stagedSceneId: 4, stagedScene: { name: 'Open' } }, accept)).toEqual({
      stagedSceneId: 4,
      stagedScene: { name: 'Open' },
    });
    expect(accept).toHaveBeenCalledWith({ stagedSceneId: 4, stagedScene: { name: 'Open' } }, 'state');
    expect(acceptStageSceneResponse({ stagedSceneId: Number.NaN, stagedScene: 'Open' }, accept)).toEqual({
      stagedSceneId: null,
      stagedScene: null,
    });
    expect(acceptStageSceneResponse({ stagedSceneId: '4', stagedScene: null }, accept)).toEqual({
      stagedSceneId: null,
      stagedScene: null,
    });
  });
});

describe('time override clock', () => {
  it('advances from the override start by the time elapsed, wrapping at midnight', () => {
    const parts = getOverrideClockParts(
      { startTime: '23:59', startedAt: '2026-11-21T10:00:00.000Z' },
      new Date('2026-11-21T10:02:05.000Z'),
    );
    expect(parts).toEqual({ hours: 0, minutes: 1, seconds: 5 });
    expect(formatClockParts(parts!)).toBe('00:01');
  });

  it('refuses an unreadable start time or start instant', () => {
    expect(getOverrideClockParts({ startTime: '24:00', startedAt: '2026-11-21T10:00:00Z' })).toBeNull();
    expect(getOverrideClockParts({ startTime: '09:30', startedAt: 'not a date' })).toBeNull();
  });
});

describe('program realtime socket URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function socketUrl(base: string, ticket?: string | null) {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', base);
    const { getProgramRealtimeSocketUrl } = await import('./programRealtimeSocket');
    return getProgramRealtimeSocketUrl('main', 'control', ticket);
  }

  it('uses wss for an https API and ws otherwise, and adds the ticket only when there is one', async () => {
    expect(await socketUrl('https://api.example.test', 'abc')).toBe(
      'wss://api.example.test/program/ws?programId=main&role=control&ticket=abc',
    );
    expect(await socketUrl('http://127.0.0.1:3000', null)).toBe(
      'ws://127.0.0.1:3000/program/ws?programId=main&role=control',
    );
  });
});
