import { ConflictException } from '@nestjs/common';
import { DEPLOY_CANDIDATE_ENV } from '../config/deploy-candidate';
import { PalazzoMachineClient } from './palazzo-machine.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
} from './palazzo-contract';
import {
  PALAZZO_EVENT_IDLE_MS,
  PalazzoProgramClient,
} from './palazzo-program.client';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioService, type PlayoutReports } from './radio.service';

// The airing walk's W4 with D4: a take while Palazzo answers but its playout (Liquidsoap) is down was accepted and
// did not air. The backend now refuses a take only on a fresh, explicit Liquidsoap-down report; a stale or missing
// report lets it through, counted, because a wrong refusal is dead air too. Fictional programs and URLs only.

const BASE = 'http://palazzo:3100';
const BOOT = 'boot-1';
const INSTANCE = 'palazzo-a';
const STALENESS_MS = 15_000;

function state(sequence: number, connected: boolean): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected,
      staleSince: connected ? null : '2026-11-26T15:00:00.000Z',
      lastSampleAt: '2026-11-26T15:00:00.000Z',
    },
    icecast: { connected: true },
    track: null,
    intro: null,
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

function event(
  sequence: number,
  type: PalazzoPlaybackEvent['type'],
  data: Record<string, unknown>,
): string {
  const body = {
    schemaVersion: 1,
    id: `${BOOT}:${sequence}`,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
  return `id: ${body.id}\nevent: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
}

function harness() {
  let push: (text: string) => void = () => undefined;
  const fetchImpl = jest.fn((url: string) => {
    if (url.endsWith('/playback/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }
    return Promise.resolve(Response.json(state(1, true)));
  });
  const metrics = new RadioMetricsService();
  const config = {
    get: (key: string) =>
      ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE })[key],
  } as never;
  const client = new PalazzoProgramClient({
    programId: 'radio-1',
    programType: 'radio',
    palazzoUrl: BASE,
    metrics,
    stalenessMs: STALENESS_MS,
    callbacks: {
      onSnapshot: jest.fn(),
      onEvent: jest.fn(),
      onStatus: jest.fn(),
      validateInstance: jest.fn().mockReturnValue('ok'),
    },
    machineClient: new PalazzoMachineClient(
      config,
      metrics,
      fetchImpl as unknown as typeof fetch,
    ),
  });
  return { client, push: (text: string) => push(text) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const WINDOW_MS = PALAZZO_EVENT_IDLE_MS + STALENESS_MS;

describe('PalazzoProgramClient.playoutReport', () => {
  // GM's condition on D4: recovery clears the down report on the first up signal, so a fresh but outdated down
  // report never refuses takes after playout is back.
  it.each([
    ['telemetry.connected', {}],
    ['audio.levels', { song: { rms: 0.1, peak: 0.2 } }],
    ['playback.position', { positionSeconds: 3, remainingSeconds: 100, status: 'playing' }],
    ['heartbeat', { liquidsoapSequence: 9 }],
  ] as const)('clears a fresh down report at once on %s', async (type, data) => {
    const h = harness();
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, false) }));
    await settle();
    expect(h.client.playoutReport()).toBe('down');
    h.push(event(2, type as PalazzoPlaybackEvent['type'], data));
    await settle();
    expect(h.client.playoutReport()).toBe('up');
    expect(h.client.getStatus().playout).toBe('up');
    h.client.stop();
  });

  it('clears a down report on a snapshot showing Liquidsoap back', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, false) }));
    await settle();
    h.push(event(2, 'snapshot', { state: state(2, true) }));
    await settle();
    expect(h.client.playoutReport()).toBe('up');
    h.client.stop();
  });

  it('keeps an up report on a sample event, and a down one on events that prove nothing', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true) }));
    await settle();
    h.push(event(2, 'heartbeat', { liquidsoapSequence: 3 }));
    await settle();
    expect(h.client.playoutReport()).toBe('up');
    h.push(event(3, 'telemetry.disconnected', { staleSince: '2026-11-26T15:00:00.000Z' }));
    await settle();
    h.push(event(4, 'playout.queued', { programId: 'radio-1', playbackId: 'p1' }));
    await settle();
    expect(h.client.playoutReport()).toBe('down');
    h.client.stop();
  });

  it('is unknown until Palazzo reports its playout', () => {
    expect(harness().client.playoutReport()).toBe('unknown');
  });

  it('reads a fresh down from a snapshot and from telemetry.disconnected, and stale once the window has passed', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true) }));
    await settle();
    expect(h.client.playoutReport()).toBe('up');
    h.push(
      event(2, 'telemetry.disconnected', {
        staleSince: '2026-11-26T15:00:00.000Z',
      }),
    );
    await settle();
    const now = Date.now();
    expect(h.client.playoutReport(now)).toBe('down');
    expect(h.client.playoutReport(now + WINDOW_MS - 1_000)).toBe('down');
    expect(h.client.playoutReport(now + WINDOW_MS + 1_000)).toBe('stale');
    // An idle reconnect's snapshot renews the report.
    h.push(event(3, 'snapshot', { state: state(3, false) }));
    await settle();
    expect(h.client.playoutReport()).toBe('down');
    // A client no longer hearing Palazzo (reconnecting or unavailable) has no fresh report.
    for (const connection of ['connecting', 'unavailable'] as const) {
      (h.client as unknown as { connection: string }).connection = connection;
      expect(h.client.playoutReport()).toBe('stale');
    }
    (h.client as unknown as { connection: string }).connection = 'polling';
    expect(h.client.playoutReport()).toBe('down');
    h.client.stop();
  });
});

const programs = {
  programState: {
    findUnique: jest
      .fn()
      .mockResolvedValue({ type: 'radio', radioSettings: { enabled: true } }),
  },
};

function radio(reports?: PlayoutReports) {
  const metrics = new RadioMetricsService();
  const service = new RadioService(
    programs as never,
    {} as never,
    {} as never,
    metrics,
    { teamId: 0 } as never,
  );
  if (reports) service.setPlayoutReports(reports);
  return { service, metrics };
}

const reporting = (report: ReturnType<PlayoutReports['playoutReport']>) => ({
  playoutReport: jest.fn().mockReturnValue(report),
});

const metricLine = (text: string, name: string, label: string) =>
  text.split('\n').find((line) => line.startsWith(`${name}{${label}}`));

describe('RadioService refuses a take on a fresh playout-down report only', () => {
  it('refuses with 409 playout_down and the desk message on a fresh down report, and counts it', async () => {
    const reports = reporting('down');
    const { service, metrics } = radio(reports);
    const refusal = service.refuseStartWhileEngineUnavailable('radio-1');
    await expect(refusal).rejects.toBeInstanceOf(ConflictException);
    await expect(refusal).rejects.toMatchObject({
      response: {
        statusCode: 409,
        reason: 'playout_down',
        message: 'Playout down: nothing can air. Nothing was taken.',
      },
    });
    expect(reports.playoutReport).toHaveBeenCalledWith('radio-1');
    const text = metrics.render();
    expect(
      metricLine(text, 'alcantara_radio_start_refused_total', 'reason="playout_down"'),
    ).toBe('alcantara_radio_start_refused_total{reason="playout_down"} 1');
  });

  it.each(['stale', 'unknown'] as const)(
    'lets a take through on a %s report, and counts it',
    async (report) => {
      const { service, metrics } = radio(reporting(report));
      await expect(
        service.refuseStartWhileEngineUnavailable('radio-1'),
      ).resolves.toBeUndefined();
      const text = metrics.render();
      expect(
        metricLine(text, 'alcantara_radio_take_playout_unconfirmed_total', `report="${report}"`),
      ).toBe(
        `alcantara_radio_take_playout_unconfirmed_total{report="${report}"} 1`,
      );
      expect(
        metricLine(text, 'alcantara_radio_start_refused_total', 'reason="playout_down"'),
      ).toBe('alcantara_radio_start_refused_total{reason="playout_down"} 0');
    },
  );

  it('lets a take through uncounted with playout up, with no engine client, or before telemetry is bound', async () => {
    for (const reports of [reporting('up'), reporting(null), undefined]) {
      const { service, metrics } = radio(reports);
      await expect(
        service.refuseStartWhileEngineUnavailable('radio-1'),
      ).resolves.toBeUndefined();
      const lines = metrics
        .render()
        .split('\n')
        .filter((line) =>
          line.startsWith('alcantara_radio_take_playout_unconfirmed_total{'),
        );
      expect(lines).toEqual([
        'alcantara_radio_take_playout_unconfirmed_total{report="stale"} 0',
        'alcantara_radio_take_playout_unconfirmed_total{report="unknown"} 0',
        'alcantara_radio_take_playout_unconfirmed_total{report="tv_leg"} 0',
      ]);
    }
  });

  // Yakko's #795 review: a simulcast program's own output airs the song on TV, so a radio playout report never
  // refuses its take; it goes through, counted. A radio-only program is still refused.
  it('lets a simulcast take through on a fresh down report, counted as tv_leg', async () => {
    const simulcast = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ type: 'both', radioSettings: { enabled: true } }),
      },
    };
    const metrics = new RadioMetricsService();
    const service = new RadioService(
      simulcast as never,
      {} as never,
      {} as never,
      metrics,
      { teamId: 0 } as never,
    );
    service.setPlayoutReports(reporting('down'));
    await expect(
      service.refuseStartWhileEngineUnavailable('simulcast-1'),
    ).resolves.toBeUndefined();
    const text = metrics.render();
    expect(
      metricLine(text, 'alcantara_radio_take_playout_unconfirmed_total', 'report="tv_leg"'),
    ).toBe('alcantara_radio_take_playout_unconfirmed_total{report="tv_leg"} 1');
    expect(
      metricLine(text, 'alcantara_radio_start_refused_total', 'reason="playout_down"'),
    ).toBe('alcantara_radio_start_refused_total{reason="playout_down"} 0');
    // An unknown program is not radio-only either: its take is not refused.
    simulcast.programState.findUnique.mockResolvedValue(null);
    await expect(
      service.refuseStartWhileEngineUnavailable('missing'),
    ).resolves.toBeUndefined();
  });

  it('ignores an unbounded report value in the counter', () => {
    const metrics = new RadioMetricsService();
    metrics.recordPlayoutUnconfirmedTake('elsewhere' as never);
    expect(metrics.render()).not.toContain('report="elsewhere"');
  });
});

describe('PalazzoRadioTelemetryService playout reports', () => {
  const previous = process.env[DEPLOY_CANDIDATE_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[DEPLOY_CANDIDATE_ENV];
    else process.env[DEPLOY_CANDIDATE_ENV] = previous;
  });

  it("binds itself to the radio service at startup and answers each program's client report", async () => {
    process.env[DEPLOY_CANDIDATE_ENV] = '1';
    const radioService = { setPlayoutReports: jest.fn() };
    const telemetry = new PalazzoRadioTelemetryService(
      {} as never,
      { setPalazzoTelemetry: jest.fn() } as never,
      new RadioMetricsService(),
      {} as never,
      {} as never,
      radioService as never,
    );
    await telemetry.onModuleInit();
    expect(radioService.setPlayoutReports).toHaveBeenCalledWith(telemetry);
    expect(telemetry.playoutReport('radio-1')).toBeNull();
    (
      telemetry as unknown as { clients: Map<string, unknown> }
    ).clients.set('radio-1', { playoutReport: () => 'down' });
    expect(telemetry.playoutReport('radio-1')).toBe('down');
  });

  it('starts without a radio service to bind, as in a module that has none', async () => {
    process.env[DEPLOY_CANDIDATE_ENV] = '1';
    const telemetry = new PalazzoRadioTelemetryService(
      {} as never,
      { setPalazzoTelemetry: jest.fn() } as never,
      new RadioMetricsService(),
      {} as never,
      {} as never,
    );
    await expect(telemetry.onModuleInit()).resolves.toBeUndefined();
  });
});
