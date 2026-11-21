import { ConfigService } from '@nestjs/config';
import {
  PalazzoMachineClient,
  PalazzoMachineError,
} from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import { parsePalazzoEvent } from './palazzo-contract';

// The next-song routes of contract gaulatti/palazzo#40 §1, against a fake
// Palazzo HTTP server that answers each status the contract defines.

const PROGRAM_ID = 'radio-1';
const BASE_URL = 'http://palazzo:3100';
const NEXT_URL = `${BASE_URL}/v1/programs/${PROGRAM_ID}/playback/next`;

const config = {
  get: (key: string) =>
    ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE_URL })[key],
} as unknown as ConfigService;

const SONG = {
  playbackId: 'next-1',
  url: 'https://media.example/next.mp3',
  title: 'Harbor Light',
  artist: 'The Lighthouse Keepers',
  coverUrl: 'https://media.example/next.jpg',
};

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(...responses: Response[]) {
  const fetchImpl = jest.fn();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  const metrics = new RadioMetricsService();
  const client = new PalazzoMachineClient(
    config,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  return { client, fetchImpl, metrics };
}

describe('PalazzoMachineClient next-song announcement', () => {
  it('PUTs the song object without an intro, keyed by the playback ID', async () => {
    const { client, fetchImpl, metrics } = setup(
      json(200, { ok: true, playbackRequestId: 'next-1', state: 'queued' }),
    );
    const segue = {
      cueInSeconds: 1,
      cueOutSeconds: 200,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 3,
      overlapSeconds: 2,
    };
    const loudness = { integratedLufs: -14, truePeakDbtp: -1 };

    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, { ...SONG, segue, loudness }),
    ).resolves.toEqual({ result: 'accepted', duplicate: false });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(NEXT_URL);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'next-1',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      song: { programId: PROGRAM_ID, ...SONG, segue, loudness },
    });
    expect(metrics.snapshot().machineRequests).toEqual({
      'next-announce:success': 1,
    });
  });

  it('sends neither segue nor loudness when the command has none', async () => {
    const { client, fetchImpl } = setup(
      json(200, { ok: true, playbackRequestId: 'next-1', state: 'queued' }),
    );
    await client.announceNext(BASE_URL, PROGRAM_ID, SONG);
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { song: Record<string, unknown> };
    expect(Object.keys(body.song).sort()).toEqual(
      ['artist', 'coverUrl', 'playbackId', 'programId', 'title', 'url'].sort(),
    );
  });

  it('reports a duplicate as accepted', async () => {
    const { client, metrics } = setup(
      json(200, {
        ok: true,
        playbackRequestId: 'next-1',
        state: 'queued',
        duplicate: true,
      }),
    );
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).resolves.toEqual({ result: 'accepted', duplicate: true });
    expect(metrics.snapshot().machineRequests).toEqual({
      'next-announce:deduplicated': 1,
    });
  });

  it.each([
    [409, { ok: false, reason: 'no_current_song' }, 'rejected'],
    [422, { ok: false, reason: 'not_ready' }, 'not_ready'],
    [400, { ok: false, reason: 'invalid' }, 'rejected'],
    [404, undefined, 'unsupported'],
  ])('maps %s to %s without retrying', async (status, body, result) => {
    const { client, fetchImpl } = setup(json(status, body));
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).resolves.toEqual({ result });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws any other failure as for the song command', async () => {
    const { client } = setup(json(401));
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).rejects.toEqual(new PalazzoMachineError('unauthorized', 401));

    const unreachable = setup();
    unreachable.fetchImpl.mockRejectedValue(new Error('connection refused'));
    await expect(
      unreachable.client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).rejects.toEqual(new PalazzoMachineError('unavailable'));
  });

  it('rejects a malformed answer', async () => {
    for (const body of [
      { ok: true, playbackRequestId: 'other', state: 'queued' },
      { ok: true, playbackRequestId: 'next-1' },
      { ok: true, playbackRequestId: 'next-1', state: 7 },
      {
        ok: true,
        playbackRequestId: 'next-1',
        state: 'queued',
        duplicate: 'yes',
      },
      { ok: false, playbackRequestId: 'next-1', state: 'queued' },
    ]) {
      const { client } = setup(json(200, body));
      await expect(
        client.announceNext(BASE_URL, PROGRAM_ID, SONG),
      ).rejects.toEqual(new PalazzoMachineError('malformed'));
    }
  });

  it('validates segue and loudness exactly as the song command does', async () => {
    const { client, fetchImpl, metrics } = setup();
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, {
        ...SONG,
        segue: {
          cueInSeconds: 5,
          cueOutSeconds: 1,
          fadeInSeconds: 0,
          fadeOutSeconds: 0,
          overlapSeconds: 0,
        },
      }),
    ).rejects.toEqual(new PalazzoMachineError('rejected'));
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, {
        ...SONG,
        loudness: { integratedLufs: 3, truePeakDbtp: -1 },
      }),
    ).rejects.toEqual(new PalazzoMachineError('rejected'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(metrics.snapshot().machineRequests).toEqual({
      'next-announce:rejected': 2,
    });
  });
});

describe('PalazzoMachineClient next-song withdrawal', () => {
  it('DELETEs the announcement and reports whether one was withdrawn', async () => {
    const { client, fetchImpl, metrics } = setup(
      json(200, { ok: true, withdrawn: true }),
      json(200, { ok: true, withdrawn: false }),
    );
    await expect(client.withdrawNext(BASE_URL, PROGRAM_ID)).resolves.toEqual({
      withdrawn: true,
    });
    await expect(client.withdrawNext(BASE_URL, PROGRAM_ID)).resolves.toEqual({
      withdrawn: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(NEXT_URL);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(metrics.snapshot().machineRequests).toEqual({
      'next-withdraw:success': 2,
    });
  });

  it('rejects a malformed answer', async () => {
    const { client } = setup(json(200, { ok: true }));
    await expect(client.withdrawNext(BASE_URL, PROGRAM_ID)).rejects.toEqual(
      new PalazzoMachineError('malformed'),
    );
  });
});

describe('Palazzo next-song events', () => {
  const envelope = (type: string, data: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: 'boot-1:9',
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence: 9,
    type,
    occurredAt: '2026-11-17T12:00:00.000Z',
    data,
  });

  it('accepts next_queued and next_withdrawn with every contract reason', () => {
    expect(
      parsePalazzoEvent(
        envelope('playout.next_queued', {
          programId: PROGRAM_ID,
          playbackId: 'next-1',
        }),
      ),
    ).not.toBeNull();
    for (const reason of ['replaced', 'withdrawn', 'flushed', 'not_ready']) {
      expect(
        parsePalazzoEvent(
          envelope('playout.next_withdrawn', {
            programId: PROGRAM_ID,
            playbackId: 'next-1',
            reason,
          }),
        ),
      ).not.toBeNull();
    }
  });

  it('rejects a missing playback ID or reason', () => {
    expect(
      parsePalazzoEvent(
        envelope('playout.next_queued', { programId: PROGRAM_ID }),
      ),
    ).toBeNull();
    expect(
      parsePalazzoEvent(
        envelope('playout.next_withdrawn', {
          programId: PROGRAM_ID,
          playbackId: 'next-1',
        }),
      ),
    ).toBeNull();
  });

  // gaulatti/ariston#217: an unknown reason keeps the event, read as `other`.
  it('keeps an unknown reason as other and reports it', () => {
    const seen: string[] = [];
    const parsed = parsePalazzoEvent(
      envelope('playout.next_withdrawn', {
        programId: PROGRAM_ID,
        playbackId: 'next-1',
        reason: 'a_reason_from_the_future',
      }),
      (field) => seen.push(field),
    );
    expect(parsed?.data.reason).toBe('other');
    expect(seen).toEqual(['withdrawn-reason']);
    expect(
      parsePalazzoEvent(
        envelope('playout.next_withdrawn', {
          programId: PROGRAM_ID,
          playbackId: 'next-1',
          reason: 'flushed',
        }),
        (field) => seen.push(field),
      )?.data.reason,
    ).toBe('flushed');
    expect(seen).toEqual(['withdrawn-reason']);
  });
});

// gaulatti/ariston#217: an answer state Alcantara does not know is read as
// rejected (not announced) and counted, instead of a malformed failure.
describe('PalazzoMachineClient next-song announcement: unknown state', () => {
  const series = (metrics: RadioMetricsService, result: string) =>
    Number(
      metrics
        .render()
        .split('\n')
        .find((line) =>
          line.startsWith(
            `alcantara_palazzo_machine_requests_total{operation="next-announce",result="${result}"} `,
          ),
        )
        ?.split(' ')
        .pop(),
    );

  it('returns rejected for an unknown state and counts it as unknown-value', async () => {
    const { client, metrics } = setup(
      json(200, { ok: true, playbackRequestId: 'next-1', state: 'held' }),
    );
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).resolves.toEqual({ result: 'rejected' });
    expect(series(metrics, 'unknown-value')).toBe(1);
    expect(series(metrics, 'malformed')).toBe(0);
    expect(metrics.render()).not.toContain('held');
  });

  it('still rejects a mismatched playback ID echo as malformed', async () => {
    const { client, metrics } = setup(
      json(200, { ok: true, playbackRequestId: 'other', state: 'held' }),
    );
    await expect(
      client.announceNext(BASE_URL, PROGRAM_ID, SONG),
    ).rejects.toEqual(new PalazzoMachineError('malformed'));
    expect(series(metrics, 'unknown-value')).toBe(0);
  });
});

// gaulatti/alcantara#232 (contract gaulatti/palazzo#50): the spot rides on the
// announcement only when the engine gives one; without it the body is as before.
describe('PalazzoMachineClient next-song announcement with a spot', () => {
  it('adds the bumper object, and nothing else, when the command carries one', async () => {
    const { client, fetchImpl } = setup(
      json(200, { ok: true, playbackRequestId: 'next-1', state: 'queued' }),
      json(200, { ok: true, playbackRequestId: 'next-1', state: 'queued' }),
    );
    await client.announceNext(BASE_URL, PROGRAM_ID, {
      ...SONG,
      bumper: { playbackId: 'spot-1', url: 'https://media.example/spot.mp3' },
    });
    await client.announceNext(BASE_URL, PROGRAM_ID, SONG);
    const bodies = fetchImpl.mock.calls.map(
      (call) =>
        JSON.parse((call as [string, RequestInit])[1].body as string) as Record<
          string,
          unknown
        >,
    );
    expect(bodies[0]).toEqual({
      song: { programId: PROGRAM_ID, ...SONG },
      bumper: { playbackId: 'spot-1', url: 'https://media.example/spot.mp3' },
    });
    expect(bodies[1]).not.toHaveProperty('bumper');
  });
});
