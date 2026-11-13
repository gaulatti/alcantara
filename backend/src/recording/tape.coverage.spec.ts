import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaRecordingClient,
  type RecordingFetch,
} from './alana-recording.client';
import { RecordingDownloadTicketService } from './recording-download-ticket.service';
import { RecordingFileController } from './recording-file.controller';
import { normalizeTapeStatus } from './recording.contract';
import { TapeController } from './tape.controller';

const TOKEN = 'a'.repeat(64);

const recording = {
  enabled: true,
  state: 'idle',
  requestedAt: null,
  startedAt: null,
  stoppedAt: null,
  finalizedAt: null,
  updatedAt: null,
  segmentCount: 0,
  bytes: 0,
  durationSeconds: 0,
  droppedFrames: 0,
  errors: 0,
  restarts: 0,
  finalizationState: 'not-requested',
  finalBytes: 0,
  error: null,
  disk: null,
};

function client(transport: jest.Mock) {
  return new AlanaRecordingClient(
    new ConfigService({
      NODE_ENV: 'test',
      ALANA_CONTROL_URL: 'http://alana:8080',
      ALANA_CONTROL_TOKEN: TOKEN,
    }),
    new ManagedMetricsService(),
    transport as unknown as RecordingFetch,
  );
}

describe('AlanaRecordingClient tape and file edge cases', () => {
  it('maps an unreachable Alana to 503 for status and for commands', async () => {
    const down = jest.fn().mockRejectedValue(new Error('refused'));
    await expect(client(down).tapeStatus('main')).rejects.toMatchObject({
      response: { error: 'ALANA_TAPE_UNAVAILABLE' },
    });
    await expect(
      client(down).tapeCommand('main', 'start', 'key-1'),
    ).rejects.toMatchObject({ response: { error: 'ALANA_TAPE_UNAVAILABLE' } });
  });

  it('maps an unparseable command response to 502', async () => {
    const garbage = jest.fn().mockResolvedValue(new Response('not json'));
    await expect(
      client(garbage).tapeCommand('main', 'stop', 'key-2'),
    ).rejects.toMatchObject({
      response: { error: 'ALANA_TAPE_INVALID_RESPONSE' },
    });
  });

  it('falls back to 502 for a non-error status that is still not ok', async () => {
    const odd = jest.fn().mockResolvedValue(
      Response.json(
        {
          tape: { enabled: true, active: false, pipelineHealthy: false },
          recording,
        },
        { status: 300 },
      ),
    );
    const error: unknown = await client(odd)
      .tapeCommand('main', 'start', 'key-3')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(502);
  });

  it('reports an unreachable Alana when opening the file', async () => {
    const down = jest.fn().mockRejectedValue(new Error('refused'));
    await expect(client(down).openRecordingFile('main')).rejects.toMatchObject({
      response: { error: 'ALANA_RECORDING_UNAVAILABLE' },
    });
  });

  it('returns no body for a missing file and still cancels the upstream', async () => {
    const missing = jest
      .fn()
      .mockResolvedValue(new Response('{"error":"none"}', { status: 404 }));
    const opened = await client(missing).openRecordingFile('main');
    expect(opened.status).toBe(404);
    expect(opened.body).toBeNull();
    opened.abort();
  });

  it('tolerates a missing-file response without a body', async () => {
    const empty = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const opened = await client(empty).openRecordingFile('main');
    expect(opened.body).toBeNull();
  });

  it('passes an unsatisfiable range through with its headers and a body', async () => {
    const rangeError = jest.fn().mockResolvedValue(
      new Response('x', {
        status: 416,
        headers: { 'content-range': 'bytes */5' },
      }),
    );
    const opened = await client(rangeError).openRecordingFile(
      'main',
      'bytes=9-',
    );
    expect(opened.status).toBe(416);
    expect(opened.headers['content-range']).toBe('bytes */5');
    expect(opened.body).toBeInstanceOf(Readable);
    opened.body?.destroy();
  });

  it('omits the Range header when none was requested', async () => {
    const ok = jest.fn().mockResolvedValue(new Response('abc'));
    await client(ok).openRecordingFile('main');
    const init = (ok.mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(init.headers).has('Range')).toBe(false);
  });
});

describe('normalizeTapeStatus command results', () => {
  const base = {
    tape: { enabled: true, active: false, pipelineHealthy: false },
    recording,
  };

  it('ignores a command result with an unknown action', () => {
    const status = normalizeTapeStatus({
      ...base,
      commandResult: { action: 'pause', status: 200, result: 'accepted' },
    });
    expect(status.commandResult).toBeUndefined();
  });

  it('maps an unrecognised result to unknown', () => {
    const status = normalizeTapeStatus({
      ...base,
      commandResult: { action: 'start', status: 202, result: 'mystery' },
    });
    expect(status.commandResult?.result).toBe('unknown');
  });
});

describe('RecordingDownloadTicketService capacity', () => {
  it('evicts the oldest ticket once the cap is reached', () => {
    const service = new RecordingDownloadTicketService();
    const first = service.issue('main').ticket;
    for (let index = 0; index < 100; index += 1) service.issue('main');
    expect(service.validate(first, 'main')).toBe(false);
  });
});

describe('Controllers delegate to the client', () => {
  it('TapeController.status reads the normalized program tape', async () => {
    const tapeStatus = jest.fn().mockResolvedValue({ tape: {} });
    const controller = new TapeController({
      tapeStatus,
    } as unknown as AlanaRecordingClient);
    await controller.status('modo italiano');
    expect(tapeStatus).toHaveBeenCalledWith('modo italiano');
  });

  it('RecordingFileController issues a ticket for the normalized program', () => {
    const controller = new RecordingFileController(
      {} as unknown as AlanaRecordingClient,
      new RecordingDownloadTicketService(),
    );
    expect(controller.issue('main').ticket).toEqual(expect.any(String));
  });

  it('answers an unsatisfiable range with 416 and no body', async () => {
    const tickets = new RecordingDownloadTicketService();
    const { ticket } = tickets.issue('main');
    const open = jest.fn().mockResolvedValue({
      status: 416,
      headers: { 'content-range': 'bytes */5' },
      body: null,
      abort: jest.fn(),
    });
    const controller = new RecordingFileController(
      { openRecordingFile: open } as unknown as AlanaRecordingClient,
      tickets,
    );
    const reply = {
      raw: { once: jest.fn() },
      status: jest.fn().mockReturnThis(),
      headers: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    await controller.file('main', ticket, 'bytes=9-', reply as never);
    expect(reply.status).toHaveBeenCalledWith(416);
    expect(reply.headers).toHaveBeenCalledWith({
      'content-range': 'bytes */5',
    });
    expect(reply.send).toHaveBeenCalledWith();
  });
});
