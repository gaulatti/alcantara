import {
  PalazzoMachineClient,
  PalazzoMachineError,
} from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';

const PROGRAM_ID = 'radio-1';
const BASE_URL = 'http://palazzo:3100';
const TOKEN = 'palazzo-fictional-control-token';

function config(values: Record<string, string> = {}) {
  return {
    get: (key: string) =>
      ({
        NODE_ENV: 'test',
        PALAZZO_CONTROL_TOKEN: TOKEN,
        PALAZZO_ALLOWED_URLS: BASE_URL,
        ...values,
      })[key],
  } as any;
}

function state(introProgramId = PROGRAM_ID) {
  return {
    schemaVersion: 1,
    instanceId: 'palazzo-a',
    bootId: 'boot-a',
    sequence: 7,
    availability: 'available',
    status: 'playing',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: '2026-08-25T12:00:00.000Z',
    },
    icecast: { connected: true },
    track: {
      playbackRequestId: 'song-1',
      title: 'Fictional song',
      artist: 'Fictional artist',
      coverUrl: null,
      url: 'https://media.example/song.mp3',
      startedAt: '2026-08-25T12:00:00.000Z',
    },
    intro: {
      playbackId: 'intro-1',
      parentPlaybackId: 'song-1',
      programId: introProgramId,
      playbackRequestId: 'song-1',
      url: 'https://media.example/intro.mp3',
      startedAt: '2026-08-25T12:00:00.000Z',
      status: 'playing',
    },
    positionSeconds: 4,
    remainingSeconds: 120,
    levels: {
      song: { rms: 0.2, peak: 0.4 },
      intro: { rms: 0.1, peak: 0.2 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0.2, peak: 0.4 },
    },
  };
}

describe('PalazzoMachineClient', () => {
  it('fails construction without production credentials or an allowlisted target', () => {
    expect(
      () =>
        new PalazzoMachineClient(
          config({ NODE_ENV: 'production', PALAZZO_CONTROL_TOKEN: '' }),
          new RadioMetricsService(),
        ),
    ).toThrow('PALAZZO_CONTROL_TOKEN is missing or invalid');
    expect(
      () =>
        new PalazzoMachineClient(
          config({ NODE_ENV: 'production', PALAZZO_ALLOWED_URLS: '' }),
          new RadioMetricsService(),
        ),
    ).toThrow('PALAZZO_ALLOWED_URLS must contain an approved URL');
  });

  it('retries an idempotent song command with the same scoped IDs and credential', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          playbackRequestId: 'song-1',
          duplicate: true,
        }),
      );
    const metrics = new RadioMetricsService();
    const client = new PalazzoMachineClient(config(), metrics, fetchImpl);

    const result = await client.playSong(BASE_URL, PROGRAM_ID, {
      playbackId: 'song-1',
      url: 'https://media.example/song.mp3',
      title: 'Fictional song',
    });

    expect(result).toEqual({ playbackRequestId: 'song-1', duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe('http://palazzo:3100/v1/programs/radio-1/playback/song');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers['Idempotency-Key']).toBe('song-1');
      expect(JSON.parse(init.body)).toEqual({
        song: {
          programId: PROGRAM_ID,
          playbackId: 'song-1',
          url: 'https://media.example/song.mp3',
          title: 'Fictional song',
        },
      });
    }
    expect(metrics.snapshot().machineRetries['song-play']).toBe(1);
    expect(metrics.snapshot().machineRequests['song-play:deduplicated']).toBe(
      1,
    );
  });

  it('uses authenticated program routes for instant, mixer, state, stop, and SSE', async () => {
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/playback/instant')) {
        return Response.json({ ok: true, playbackRequestId: 'instant-1' });
      }
      if (url.endsWith('/playback/state')) return Response.json(state());
      if (url.endsWith('/mixer')) {
        return Response.json({
          mainVolume: 1,
          songVolume: 0.8,
          instantVolume: 0.7,
          songMuted: false,
          instantMuted: false,
        });
      }
      if (url.endsWith('/playback/events')) {
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      expect(init.method).toBe('POST');
      return Response.json({ ok: true });
    });
    const client = new PalazzoMachineClient(
      config(),
      new RadioMetricsService(),
      fetchImpl as unknown as typeof fetch,
    );
    await client.playInstant(BASE_URL, PROGRAM_ID, {
      playbackId: 'instant-1',
      url: 'https://media.example/instant.mp3',
      volume: 0.5,
    });
    await client.stopSong(BASE_URL, PROGRAM_ID);
    await client.stopInstants(BASE_URL, PROGRAM_ID);
    await client.updateMixer(BASE_URL, PROGRAM_ID, {
      mainVolume: 1,
      songVolume: 0.8,
      instantVolume: 0.7,
      songMuted: false,
      instantMuted: false,
    });
    await client.getMixer(BASE_URL, PROGRAM_ID);
    expect((await client.getPlaybackState(BASE_URL, PROGRAM_ID)).sequence).toBe(
      7,
    );
    const controller = new AbortController();
    await client.connectEvents(
      BASE_URL,
      PROGRAM_ID,
      'boot-a:6',
      controller.signal,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toContain('/v1/programs/radio-1/');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
    const eventCall = fetchImpl.mock.calls.at(-1);
    expect(eventCall?.[1].headers['Last-Event-ID']).toBe('boot-a:6');
  });

  it('fails closed for unauthorized, malformed, cross-program, and unapproved targets', async () => {
    const unauthorized = new PalazzoMachineClient(
      config(),
      new RadioMetricsService(),
      jest.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    await expect(
      unauthorized.getPlaybackState(BASE_URL, PROGRAM_ID),
    ).rejects.toMatchObject({
      reason: 'unauthorized',
    });

    const malformed = new PalazzoMachineClient(
      config(),
      new RadioMetricsService(),
      jest.fn().mockResolvedValue(Response.json({ status: 'playing' })),
    );
    await expect(
      malformed.getPlaybackState(BASE_URL, PROGRAM_ID),
    ).rejects.toMatchObject({
      reason: 'malformed',
    });

    const crossProgram = new PalazzoMachineClient(
      config(),
      new RadioMetricsService(),
      jest.fn().mockResolvedValue(Response.json(state('another-program'))),
    );
    await expect(
      crossProgram.getPlaybackState(BASE_URL, PROGRAM_ID),
    ).rejects.toMatchObject({
      reason: 'cross-program',
    });

    const fetchImpl = jest.fn();
    const restricted = new PalazzoMachineClient(
      config(),
      new RadioMetricsService(),
      fetchImpl,
    );
    await expect(
      restricted.getPlaybackState('https://attacker.example', PROGRAM_ID),
    ).rejects.toBeInstanceOf(PalazzoMachineError);
    await expect(
      restricted.getPlaybackState(BASE_URL, 'missing/program'),
    ).rejects.toMatchObject({ reason: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
