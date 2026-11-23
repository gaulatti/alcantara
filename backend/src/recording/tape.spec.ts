import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaRecordingClient,
  type RecordingFetch,
} from './alana-recording.client';
import { RecordingDownloadTicketService } from './recording-download-ticket.service';
import { RecordingFileController } from './recording-file.controller';
import { TapeController } from './tape.controller';

const TOKEN =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const recording = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'active',
  requestedAt: '2026-11-12T18:00:00Z',
  startedAt: '2026-11-12T18:00:01Z',
  stoppedAt: null,
  finalizedAt: null,
  updatedAt: '2026-11-12T18:00:02Z',
  segmentCount: 2,
  bytes: 2000,
  durationSeconds: 10,
  droppedFrames: 0,
  errors: 0,
  restarts: 0,
  finalizationState: 'not-requested',
  finalBytes: 0,
  error: null,
  disk: null,
  ...overrides,
});

const tapeBody = (
  tape: Record<string, unknown> = {},
  rec: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  tape: { enabled: true, active: true, pipelineHealthy: true, ...tape },
  recording: recording(rec),
  ...extra,
});

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

describe('AlanaRecordingClient tape', () => {
  it('reads tape status from the program-scoped route', async () => {
    const transport = jest.fn().mockResolvedValue(Response.json(tapeBody()));
    const result = await client(transport).tapeStatus('modo italiano');
    expect(transport).toHaveBeenCalledWith(
      'http://alana:8080/v1/programs/modo%20italiano/tape',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.tape.active).toBe(true);
    expect(result.recording.state).toBe('active');
  });

  it('posts commands with the idempotency key and a long-wait timeout', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const transport = jest.fn().mockResolvedValue(
      Response.json(
        tapeBody(
          {},
          {},
          {
            commandResult: {
              action: 'start',
              status: 202,
              result: 'accepted',
              duplicate: false,
            },
          },
        ),
        { status: 202 },
      ),
    );
    await client(transport).tapeCommand('main', 'start', 'tape-key-1');
    expect(transport).toHaveBeenCalledWith(
      'http://alana:8080/v1/programs/main/tape/start',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const startInit = (transport.mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(startInit.headers).get('Idempotency-Key')).toBe(
      'tape-key-1',
    );
    expect(timeout).toHaveBeenCalledWith(120_000);
    await client(
      jest.fn().mockResolvedValue(Response.json(tapeBody())),
    ).tapeCommand('main', 'stop', 'tape-key-2');
    expect(timeout).toHaveBeenCalledWith(150_000);
    timeout.mockRestore();
  });

  it('surfaces a rejected command with its bounded reason and status', async () => {
    const transport = jest.fn().mockResolvedValue(
      Response.json(
        tapeBody(
          { active: false },
          { state: 'idle' },
          {
            commandResult: {
              action: 'start',
              status: 409,
              result: 'program-live',
              duplicate: false,
            },
          },
        ),
        { status: 409 },
      ),
    );
    const error = await client(transport)
      .tapeCommand('main', 'start', 'tape-key-3')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: 'TAPE_COMMAND_REJECTED',
      reason: 'program-live',
    });
  });

  it('rejects malformed tape responses', async () => {
    const transport = jest
      .fn()
      .mockResolvedValue(Response.json({ tape: { active: 'yes' } }));
    await expect(client(transport).tapeStatus('main')).rejects.toMatchObject({
      response: { error: 'ALANA_TAPE_INVALID_RESPONSE' },
    });
  });

  it('streams the file, forwards Range, and keeps only download headers', async () => {
    const transport = jest.fn().mockResolvedValue(
      new Response('0123456789', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-9/100',
          'content-length': '10',
          'set-cookie': 'leak=1',
        },
      }),
    );
    const opened = await client(transport).openRecordingFile(
      'main',
      'bytes=0-9',
    );
    expect(transport).toHaveBeenCalledWith(
      'http://alana:8080/v1/programs/main/recording/file',
      expect.anything(),
    );
    const rangeInit = (transport.mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(rangeInit.headers).get('Range')).toBe('bytes=0-9');
    expect(opened.status).toBe(206);
    expect(opened.headers['set-cookie']).toBeUndefined();
    expect(opened.headers['content-range']).toBe('bytes 0-9/100');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body as Readable)
      chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('0123456789');
  });
});

describe('RecordingDownloadTicketService', () => {
  it('validates only the issuing program and expires', () => {
    jest.useFakeTimers();
    const service = new RecordingDownloadTicketService();
    const { ticket } = service.issue('main');
    expect(service.validate(ticket, 'main')).toBe(true);
    expect(service.validate(ticket, 'other')).toBe(false);
    expect(service.validate(undefined, 'main')).toBe(false);
    expect(service.validate('nope', 'main')).toBe(false);
    jest.advanceTimersByTime(RecordingDownloadTicketService.TTL_MS + 1);
    expect(service.validate(ticket, 'main')).toBe(false);
    jest.useRealTimers();
  });
});

describe('TapeController permissions and keys', () => {
  const tapeCommand = jest.fn();
  const controller = new TapeController({
    tapeCommand,
    tapeStatus: jest.fn(),
  } as unknown as AlanaRecordingClient);

  const handler = (name: string): object => {
    const value: unknown = Object.getOwnPropertyDescriptor(
      TapeController.prototype,
      name,
    )?.value;
    if (typeof value !== 'function') throw new Error(`missing ${name}`);
    return value;
  };

  it('requires read for status and operate for start and stop', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, TapeController)).toBe(
      ALCANTARA_PERMISSIONS.program.read,
    );
    for (const name of ['start', 'stop']) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler(name))).toBe(
        ALCANTARA_PERMISSIONS.program.operate,
      );
    }
  });

  it('passes the caller key through and rejects bad identifiers', () => {
    void controller.start('main', 'tape-1');
    expect(tapeCommand).toHaveBeenCalledWith('main', 'start', 'tape-1');
    expect(() => void controller.start('main', undefined)).toThrow(
      BadRequestException,
    );
    expect(() => void controller.stop('a/b', 'tape-2')).toThrow(
      BadRequestException,
    );
  });
});

describe('RecordingFileController', () => {
  const open = jest.fn();
  const tickets = new RecordingDownloadTicketService();
  const controller = new RecordingFileController(
    { openRecordingFile: open } as unknown as AlanaRecordingClient,
    tickets,
  );
  const makeReply = () => {
    const raw = new Readable({ read() {} }) as unknown as {
      once: jest.Mock;
    };
    raw.once = jest.fn();
    const reply = {
      raw,
      status: jest.fn().mockReturnThis(),
      headers: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    return reply;
  };
  const get = (name: string): object => {
    const value: unknown = Object.getOwnPropertyDescriptor(
      RecordingFileController.prototype,
      name,
    )?.value;
    if (typeof value !== 'function') throw new Error(`missing ${name}`);
    return value;
  };

  beforeEach(() => open.mockReset());

  it('issuing a ticket needs operate access while the file route is public', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, get('issue'))).toBe(
      ALCANTARA_PERMISSIONS.program.operate,
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, get('file'))).toBe(true);
  });

  it('refuses a missing, wrong-program, or invalid ticket without calling Alana', async () => {
    const { ticket } = tickets.issue('main');
    const reply = makeReply();
    await expect(
      controller.file('main', undefined, undefined, reply as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.file('other', ticket, undefined, reply as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(open).not.toHaveBeenCalled();
  });

  it('streams a ticketed download with Alana headers and no-store', async () => {
    const { ticket } = tickets.issue('main');
    const body = Readable.from(['x']);
    const abort = jest.fn();
    open.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-disposition': 'attachment; filename="program-1.mp4"',
      },
      body,
      abort,
    });
    const reply = makeReply();
    await controller.file('main', ticket, 'bytes=0-', reply as never);
    expect(open).toHaveBeenCalledWith('main', 'bytes=0-');
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.headers).toHaveBeenCalledWith(
      expect.objectContaining({
        'content-type': 'video/mp4',
        'cache-control': 'no-store',
      }),
    );
    expect(reply.send).toHaveBeenCalledWith(body);
    expect(reply.raw.once).toHaveBeenCalledWith('close', abort);
  });

  it('drops a malformed Range instead of forwarding it', async () => {
    const { ticket } = tickets.issue('main');
    open.mockResolvedValue({
      status: 200,
      headers: {},
      body: Readable.from(['x']),
      abort: jest.fn(),
    });
    await controller.file(
      'main',
      ticket,
      'bytes=0-1,5-9; evil',
      makeReply() as never,
    );
    expect(open).toHaveBeenCalledWith('main', undefined);
  });

  it('reports 404 when no verified file exists', async () => {
    const { ticket } = tickets.issue('main');
    open.mockResolvedValue({
      status: 404,
      headers: {},
      body: null,
      abort: jest.fn(),
    });
    await expect(
      controller.file('main', ticket, undefined, makeReply() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
