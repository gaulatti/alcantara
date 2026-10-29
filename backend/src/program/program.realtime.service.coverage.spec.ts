import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ProgramRealtimeService } from './program.realtime.service';

jest.mock('ws', () => {
  const { EventEmitter: Emitter } = jest.requireActual('node:events');
  class FakeWebSocket {
    static readonly OPEN = 1;
  }
  class FakeWebSocketServer {
    static instances: FakeWebSocketServer[] = [];
    readonly handleUpgrade = jest.fn(
      (
        _request: unknown,
        _socket: unknown,
        _head: unknown,
        callback: (ws: unknown) => void,
      ) => callback(FakeWebSocketServer.nextSocket()),
    );
    readonly close = jest.fn();
    static nextSocket: () => unknown = () => new Emitter();
    constructor(readonly options: unknown) {
      FakeWebSocketServer.instances.push(this);
    }
  }
  return { WebSocket: FakeWebSocket, WebSocketServer: FakeWebSocketServer };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer: FakeServer } = require('ws') as {
  WebSocketServer: {
    instances: Array<{
      options: unknown;
      handleUpgrade: jest.Mock;
      close: jest.Mock;
    }>;
    nextSocket: () => unknown;
  };
};

class FakeSocket extends EventEmitter {
  readyState = 1;
  send = jest.fn();
  close = jest.fn();
}
class FakeHttpServer extends EventEmitter {}

type Listener = (event: {
  scope: 'program' | 'global';
  programId: string | null;
  data: unknown;
}) => void;

function build() {
  let listener: Listener = () => undefined;
  const removeListener = jest.fn();
  const programService = {
    addEventListener: jest.fn((fn: Listener) => {
      listener = fn;
      return removeListener;
    }),
    getState: jest.fn().mockResolvedValue({ version: 3, id: 's' }),
    getProgramAudioBus: jest.fn().mockResolvedValue({ version: 4 }),
    getBroadcastSettings: jest.fn().mockResolvedValue({ version: 5 }),
    getProgramAudioMeter: jest.fn().mockResolvedValue({ version: 6 }),
    getProgramSongPlayback: jest.fn().mockResolvedValue({ version: 7 }),
    getProgramSceneInstantPlayback: jest.fn().mockResolvedValue({ version: 8 }),
    updateProgramAudioMeter: jest.fn().mockResolvedValue(undefined),
    updateProgramSongPlayback: jest.fn().mockResolvedValue(undefined),
  };
  const flightService = {
    handleSongEnded: jest.fn().mockResolvedValue(undefined),
  };
  const tickets = { consume: jest.fn().mockReturnValue(true) };
  const service = new ProgramRealtimeService(
    programService as never,
    flightService as never,
    tickets as never,
  );
  return {
    service,
    programService,
    flightService,
    tickets,
    removeListener,
    emit: (event: Parameters<Listener>[0]) => listener(event),
  };
}

const request = (url: string | undefined, host?: string) =>
  ({ url, headers: host === undefined ? {} : { host } }) as never;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ProgramRealtimeService lifecycle', () => {
  beforeEach(() => {
    FakeServer.instances.length = 0;
    FakeServer.nextSocket = () => new FakeSocket();
  });

  it('subscribes to program events on construction and unsubscribes on destroy', () => {
    const { service, programService, removeListener } = build();
    expect(programService.addEventListener).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(removeListener).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('attaches a no-server websocket server to the HTTP upgrade event once per server', () => {
    const { service } = build();
    const http = new FakeHttpServer();
    service.attachToServer(http as never);
    service.attachToServer(http as never);
    expect(FakeServer.instances).toHaveLength(1);
    expect(FakeServer.instances[0].options).toEqual({ noServer: true });
    expect(http.listenerCount('upgrade')).toBe(1);
  });

  it('moves to a new HTTP server, closing clients and the previous websocket server', () => {
    const { service } = build();
    const first = new FakeHttpServer();
    const second = new FakeHttpServer();
    service.attachToServer(first as never);
    const handler = first.listeners('upgrade')[0] as (...a: unknown[]) => void;
    const socket = new FakeSocket();
    FakeServer.nextSocket = () => socket;
    handler(
      request('/program/ws?role=program&programId=p', 'h'),
      new FakeSocket(),
      Buffer.alloc(0),
    );
    service.attachToServer(second as never);
    expect(first.listenerCount('upgrade')).toBe(0);
    expect(second.listenerCount('upgrade')).toBe(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(FakeServer.instances[0].close).toHaveBeenCalledTimes(1);
    expect(FakeServer.instances).toHaveLength(2);
  });

  it('ignores client close failures during detach and ignores upgrades after destroy', () => {
    const { service } = build();
    const http = new FakeHttpServer();
    service.attachToServer(http as never);
    const handler = http.listeners('upgrade')[0] as (...a: unknown[]) => void;
    const socket = new FakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    FakeServer.nextSocket = () => socket;
    handler(
      request('/program/ws?role=program', 'h'),
      new FakeSocket(),
      Buffer.alloc(0),
    );
    expect(() => service.onModuleDestroy()).not.toThrow();
    expect(socket.close).toHaveBeenCalled();

    const rejected = new FakeSocket() as FakeSocket & { end: jest.Mock };
    rejected.end = jest.fn();
    handler(
      request('/program/ws?role=program', 'h'),
      rejected,
      Buffer.alloc(0),
    );
    expect(FakeServer.instances[0].handleUpgrade).toHaveBeenCalledTimes(1);
    expect(rejected.end).not.toHaveBeenCalled();
  });

  it('does not touch an unattached service on destroy', () => {
    const { service } = build();
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});

describe('ProgramRealtimeService upgrades', () => {
  type Upgrade = (...a: unknown[]) => void;
  function attached() {
    const ctx = build();
    const http = new FakeHttpServer();
    ctx.service.attachToServer(http as never);
    const upgrade = http.listeners('upgrade')[0] as Upgrade;
    const socket = Object.assign(new FakeSocket(), { end: jest.fn() });
    const wss = FakeServer.instances.at(-1)!;
    return {
      ...ctx,
      wss,
      socket,
      upgrade: (url: string | undefined, host?: string) =>
        upgrade(request(url, host), socket, Buffer.from('head')),
    };
  }
  beforeEach(() => {
    FakeServer.instances.length = 0;
    FakeServer.nextSocket = () => new FakeSocket();
  });

  it.each([
    ['a different path', '/other?role=control', 'h'],
    ['a missing url', undefined, 'h'],
    ['an unparsable url', 'http://', 'h'],
    ['an unparsable host', '/program/ws?role=control', 'bad host'],
  ])('silently ignores upgrades with %s', (_label, url, host) => {
    const ctx = attached();
    ctx.upgrade(url, host);
    expect(ctx.wss.handleUpgrade).not.toHaveBeenCalled();
    expect(ctx.socket.end).not.toHaveBeenCalled();
  });

  it('uses localhost when the host header is missing', () => {
    const ctx = attached();
    ctx.upgrade('/program/ws?role=program');
    expect(ctx.wss.handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no role', '/program/ws'],
    ['an unknown role', '/program/ws?role=viewer'],
  ])('rejects %s with 400', (_label, url) => {
    const ctx = attached();
    ctx.upgrade(url, 'h');
    expect(ctx.socket.end).toHaveBeenCalledWith(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nA known realtime role is required',
    );
    expect(ctx.wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('accepts program renderers without a ticket', () => {
    const ctx = attached();
    ctx.upgrade('/program/ws?role=program&programId=%20show%20', 'h');
    expect(ctx.tickets.consume).not.toHaveBeenCalled();
    expect(ctx.wss.handleUpgrade).toHaveBeenCalledWith(
      expect.anything(),
      ctx.socket,
      Buffer.from('head'),
      expect.any(Function),
    );
    ctx.service.broadcastAudioMeterUpdate('show', {} as never);
  });

  it.each([
    ['no ticket', '/program/ws?role=control'],
    ['a blank ticket', '/program/ws?role=control&ticket=%20%20'],
  ])('rejects control clients with %s using 401', (_label, url) => {
    const ctx = attached();
    ctx.upgrade(url, 'h');
    expect(ctx.socket.end).toHaveBeenCalledWith(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nValid realtime ticket required',
    );
    expect(ctx.tickets.consume).not.toHaveBeenCalled();
    expect(ctx.wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects control clients whose ticket is not valid for the program', () => {
    const ctx = attached();
    ctx.tickets.consume.mockReturnValue(false);
    ctx.upgrade('/program/ws?role=control&programId=p1&ticket=%20t1%20', 'h');
    expect(ctx.tickets.consume).toHaveBeenCalledWith('t1', 'p1');
    expect(ctx.socket.end).toHaveBeenCalledWith(
      expect.stringContaining('401 Unauthorized'),
    );
    expect(ctx.wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('accepts control clients with a valid ticket and defaults the program id', () => {
    const ctx = attached();
    ctx.upgrade('/program/ws?role=control&ticket=t1', 'h');
    expect(ctx.tickets.consume).toHaveBeenCalledWith('t1', 'main');
    expect(ctx.wss.handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [500, 'Service Unavailable'],
  ])('writes the %s status line', (code, text) => {
    const { service } = build();
    const socket = { end: jest.fn() };
    (
      service as unknown as {
        rejectUpgrade: (s: unknown, c: number, r: string) => void;
      }
    ).rejectUpgrade(socket, code, 'why');
    expect(socket.end).toHaveBeenCalledWith(
      `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nwhy`,
    );
  });
});

describe('ProgramRealtimeService connections', () => {
  function connect(
    ctx: ReturnType<typeof build>,
    role: 'control' | 'program',
    programId = 'p',
    readyState = 1,
  ) {
    const socket = new FakeSocket();
    socket.readyState = readyState;
    const priv = ctx.service as unknown as {
      handleConnection: (s: unknown, p: string, r: string) => void;
    };
    priv.handleConnection(socket, programId, role);
    return socket;
  }
  const sent = (socket: FakeSocket) =>
    socket.send.mock.calls.map(([text]) => JSON.parse(text as string));

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends six snapshots with versions to a control client', async () => {
    const ctx = build();
    const socket = connect(ctx, 'control');
    await flush();
    const messages = sent(socket);
    expect(messages.map((m) => m.type).sort()).toEqual([
      'audio_bus_snapshot',
      'audio_meter_update',
      'broadcast_settings_snapshot',
      'program_state_snapshot',
      'scene_instant_state',
      'song_playback_update',
    ]);
    const byType = Object.fromEntries(messages.map((m) => [m.type, m]));
    expect(byType.program_state_snapshot).toMatchObject({
      programId: 'p',
      state: { version: 3, id: 's' },
      version: 3,
    });
    expect(byType.audio_bus_snapshot).toMatchObject({
      programId: 'p',
      settings: { version: 4 },
      version: 4,
    });
    expect(typeof byType.audio_bus_snapshot.updatedAt).toBe('string');
    expect(byType.broadcast_settings_snapshot).toMatchObject({
      settings: { version: 5 },
      version: 5,
    });
    expect(byType.broadcast_settings_snapshot).not.toHaveProperty('programId');
    expect(byType.audio_meter_update).toMatchObject({
      levels: { version: 6 },
      version: 6,
    });
    expect(byType.song_playback_update).toMatchObject({
      playback: { version: 7 },
      version: 7,
    });
    expect(byType.scene_instant_state).toMatchObject({
      playback: { version: 8 },
      version: 8,
    });
    expect(ctx.programService.getState).toHaveBeenCalledWith('p');
    expect(ctx.programService.getProgramAudioBus).toHaveBeenCalledWith('p');
    expect(ctx.programService.getBroadcastSettings).toHaveBeenCalledWith();
  });

  it('omits the version when snapshots lack a numeric one', async () => {
    const ctx = build();
    const payloads: unknown[] = [
      { version: 'abc' },
      { other: true },
      null,
      'text',
    ];
    for (const payload of payloads) {
      for (const method of [
        'getState',
        'getProgramAudioBus',
        'getBroadcastSettings',
        'getProgramAudioMeter',
        'getProgramSongPlayback',
        'getProgramSceneInstantPlayback',
      ] as const) {
        ctx.programService[method].mockResolvedValue(payload);
      }
      const socket = connect(ctx, 'control');
      await flush();
      const messages = sent(socket);
      expect(messages).toHaveLength(6);
      for (const message of messages) {
        expect(message.version).toBeUndefined();
      }
    }
  });

  it('sends nothing to program clients and skips snapshots for closed sockets', async () => {
    const ctx = build();
    const renderer = connect(ctx, 'program');
    const closed = connect(ctx, 'control', 'p', 3);
    await flush();
    expect(ctx.programService.getState).toHaveBeenCalledTimes(1);
    expect(renderer.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('survives snapshot loading failures and send failures', async () => {
    const ctx = build();
    for (const method of [
      'getState',
      'getProgramAudioBus',
      'getBroadcastSettings',
      'getProgramAudioMeter',
      'getProgramSongPlayback',
      'getProgramSceneInstantPlayback',
    ] as const) {
      ctx.programService[method].mockRejectedValue(new Error('db'));
    }
    const failing = connect(ctx, 'control');
    await flush();
    expect(failing.send).not.toHaveBeenCalled();

    for (const method of [
      'getState',
      'getProgramAudioBus',
      'getBroadcastSettings',
      'getProgramAudioMeter',
      'getProgramSongPlayback',
      'getProgramSceneInstantPlayback',
    ] as const) {
      ctx.programService[method].mockResolvedValue({ version: 1 });
    }
    const broken = new FakeSocket();
    broken.send.mockImplementation(() => {
      throw new Error('broken pipe');
    });
    (
      ctx.service as unknown as {
        handleConnection: (s: unknown, p: string, r: string) => void;
      }
    ).handleConnection(broken, 'p', 'control');
    await flush();
    expect(broken.send).toHaveBeenCalledTimes(6);
  });

  it('forgets clients on close and on error, logging errors', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const ctx = build();
    const closing = connect(ctx, 'program');
    const failing = connect(ctx, 'program');
    const staying = connect(ctx, 'program');
    closing.emit('close');
    failing.emit('error', new Error('reset'));
    expect(warn).toHaveBeenCalledWith('Program WS client error: Error: reset');
    ctx.service.broadcastAudioMeterUpdate('p', { updatedAt: 'x' } as never);
    expect(closing.send).not.toHaveBeenCalled();
    expect(failing.send).not.toHaveBeenCalled();
    expect(staying.send).toHaveBeenCalledTimes(1);
  });

  it('broadcasts meter and playback updates only to open clients of the same program', () => {
    const ctx = build();
    const same = connect(ctx, 'control', 'p');
    const other = connect(ctx, 'program', 'q');
    const closed = connect(ctx, 'program', 'p', 3);
    const sameControl = connect(ctx, 'program', 'p');
    same.send.mockClear();
    ctx.service.broadcastAudioMeterUpdate(' p ', { updatedAt: 'u' } as never);
    ctx.service.broadcastSongPlaybackUpdate('p', { token: 't' } as never);
    for (const socket of [same, sameControl]) {
      expect(sent(socket)).toEqual([
        {
          type: 'audio_meter_update',
          programId: 'p',
          levels: { updatedAt: 'u' },
        },
        {
          type: 'song_playback_update',
          programId: 'p',
          playback: { token: 't' },
        },
      ]);
    }
    expect(other.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('defaults blank or non-string program ids to main when broadcasting', () => {
    const ctx = build();
    const main = connect(ctx, 'program', 'main');
    ctx.service.broadcastAudioMeterUpdate('   ', {} as never);
    ctx.service.broadcastSongPlaybackUpdate(undefined as never, {} as never);
    expect(sent(main).map((m) => m.programId)).toEqual(['main', 'main']);
  });
});

describe('ProgramRealtimeService client messages', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const client = (role: 'program' | 'control') => ({
    socket: new FakeSocket(),
    programId: 'p',
    role,
  });
  const deliver = async (
    ctx: ReturnType<typeof build>,
    clientValue: ReturnType<typeof client>,
    raw: unknown,
  ) =>
    (
      ctx.service as unknown as {
        handleMessage: (c: unknown, r: unknown) => Promise<void>;
      }
    ).handleMessage(clientValue, raw);
  const json = (value: unknown) => JSON.stringify(value);

  it('routes message events from a connected socket to the handler', async () => {
    const ctx = build();
    const socket = new FakeSocket();
    (
      ctx.service as unknown as {
        handleConnection: (s: unknown, p: string, r: string) => void;
      }
    ).handleConnection(socket, 'p', 'program');
    socket.emit('message', Buffer.from(json({ type: 'song_ended' })));
    await flush();
    expect(ctx.flightService.handleSongEnded).toHaveBeenCalledWith('p');
  });

  it('decodes strings, buffers, buffer lists and array buffers', async () => {
    const ctx = build();
    const text = json({ type: 'song_ended' });
    const program = client('program');
    await deliver(ctx, program, text);
    await deliver(ctx, program, Buffer.from(text));
    await deliver(ctx, program, [
      Buffer.from(text.slice(0, 5)),
      Buffer.from(text.slice(5)),
    ]);
    await deliver(ctx, program, new TextEncoder().encode(text).buffer);
    expect(ctx.flightService.handleSongEnded).toHaveBeenCalledTimes(4);
  });

  it('ignores empty, malformed and non-object payloads', async () => {
    const ctx = build();
    const program = client('program');
    for (const raw of ['', 'not json', 'null', '5', '"s"', 'false']) {
      await deliver(ctx, program, raw);
    }
    await deliver(ctx, program, json({ type: 'other' }));
    await deliver(ctx, program, json({}));
    expect(ctx.programService.updateProgramAudioMeter).not.toHaveBeenCalled();
    expect(ctx.programService.updateProgramSongPlayback).not.toHaveBeenCalled();
    expect(ctx.flightService.handleSongEnded).not.toHaveBeenCalled();
  });

  it('forwards audio meter levels from program clients only', async () => {
    const ctx = build();
    const levels = { song: { vu: 1 } };
    await deliver(
      ctx,
      client('program'),
      json({ type: 'audio_meter_update', levels }),
    );
    await deliver(
      ctx,
      client('program'),
      json({ type: 'audio_meter_update', song: 1 }),
    );
    await deliver(
      ctx,
      client('control'),
      json({ type: 'audio_meter_update', levels }),
    );
    expect(ctx.programService.updateProgramAudioMeter.mock.calls).toEqual([
      [levels, 'p'],
      [{ type: 'audio_meter_update', song: 1 }, 'p'],
    ]);
  });

  it('forwards song playback from program clients only', async () => {
    const ctx = build();
    const playback = { token: 't' };
    await deliver(
      ctx,
      client('program'),
      json({ type: 'song_playback_update', playback }),
    );
    await deliver(
      ctx,
      client('program'),
      json({ type: 'song_playback_update', token: 'u' }),
    );
    await deliver(
      ctx,
      client('control'),
      json({ type: 'song_playback_update', playback }),
    );
    expect(ctx.programService.updateProgramSongPlayback.mock.calls).toEqual([
      [playback, 'p'],
      [{ type: 'song_playback_update', token: 'u' }, 'p'],
    ]);
  });

  it('swallows rejected telemetry updates', async () => {
    const ctx = build();
    ctx.programService.updateProgramAudioMeter.mockRejectedValue(
      new Error('x'),
    );
    ctx.programService.updateProgramSongPlayback.mockRejectedValue(
      new Error('x'),
    );
    await expect(
      deliver(ctx, client('program'), json({ type: 'audio_meter_update' })),
    ).resolves.toBeUndefined();
    await expect(
      deliver(ctx, client('program'), json({ type: 'song_playback_update' })),
    ).resolves.toBeUndefined();
  });

  it('only lets program clients end songs and logs failures', async () => {
    const ctx = build();
    await deliver(ctx, client('control'), json({ type: 'song_ended' }));
    expect(ctx.flightService.handleSongEnded).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      '[WS] song_ended ignored: role=control, expected=program',
    );

    ctx.flightService.handleSongEnded.mockRejectedValue(new Error('flight'));
    await deliver(ctx, client('program'), json({ type: 'song_ended' }));
    expect(console.error).toHaveBeenCalledWith('[WS] song_ended handler threw');
  });
});

describe('ProgramRealtimeService program event fan-out', () => {
  function connect(
    ctx: ReturnType<typeof build>,
    role: 'control' | 'program',
    programId: string,
    readyState = 1,
  ) {
    const socket = new FakeSocket();
    socket.readyState = readyState;
    (
      ctx.service as unknown as {
        handleConnection: (s: unknown, p: string, r: string) => void;
      }
    ).handleConnection(socket, programId, role);
    return socket;
  }
  const messages = (socket: FakeSocket) =>
    socket.send.mock.calls.map(([text]) => JSON.parse(text as string));

  function room() {
    const ctx = build();
    for (const method of [
      'getState',
      'getProgramAudioBus',
      'getBroadcastSettings',
      'getProgramAudioMeter',
      'getProgramSongPlayback',
      'getProgramSceneInstantPlayback',
    ] as const) {
      ctx.programService[method].mockRejectedValue(new Error('skip snapshots'));
    }
    return {
      ctx,
      controlP: connect(ctx, 'control', 'p'),
      controlQ: connect(ctx, 'control', 'q'),
      rendererP: connect(ctx, 'program', 'p'),
      closedP: connect(ctx, 'control', 'p', 3),
    };
  }

  it('broadcasts global events to open control clients of every program', () => {
    const { ctx, controlP, controlQ, rendererP, closedP } = room();
    ctx.emit({ scope: 'global', programId: null, data: { type: 'g' } });
    expect(messages(controlP)).toEqual([{ type: 'g' }]);
    expect(messages(controlQ)).toEqual([{ type: 'g' }]);
    expect(rendererP.send).not.toHaveBeenCalled();
    expect(closedP.send).not.toHaveBeenCalled();
  });

  it('ignores program-scoped events without a program id', () => {
    const { ctx, controlP } = room();
    ctx.emit({ scope: 'program', programId: null, data: { type: 'x' } });
    ctx.emit({ scope: 'program', programId: '', data: { type: 'x' } });
    expect(controlP.send).not.toHaveBeenCalled();
  });

  it('adds the program id to object payloads that lack one', () => {
    const { ctx, controlP, controlQ, rendererP, closedP } = room();
    ctx.emit({
      scope: 'program',
      programId: ' p ',
      data: { type: 'scene_change' },
    });
    expect(messages(controlP)).toEqual([
      { type: 'scene_change', programId: 'p' },
    ]);
    expect(controlQ.send).not.toHaveBeenCalled();
    expect(rendererP.send).not.toHaveBeenCalled();
    expect(closedP.send).not.toHaveBeenCalled();
  });

  it('keeps an explicit program id on the payload', () => {
    const { ctx, controlP } = room();
    ctx.emit({
      scope: 'program',
      programId: 'p',
      data: { type: 't', programId: 'explicit' },
    });
    expect(messages(controlP)).toEqual([{ type: 't', programId: 'explicit' }]);
  });

  it.each([
    ['null', null],
    ['a string', 'text'],
    ['an array', [1, 2]],
  ])('wraps %s payloads in a program event', (_label, data) => {
    const { ctx, controlP } = room();
    ctx.emit({ scope: 'program', programId: 'p', data });
    expect(messages(controlP)).toEqual([
      { type: 'program_event', programId: 'p', payload: data },
    ]);
  });
});

describe('ProgramRealtimeService dependency metadata', () => {
  it('declares program, flight and ticket services as constructor dependencies', () => {
    const types = Reflect.getMetadata(
      'design:paramtypes',
      ProgramRealtimeService,
    ) as Array<{ name: string }>;
    expect(types.map((type) => type.name)).toEqual([
      'ProgramService',
      'FlightService',
      'RealtimeTicketService',
    ]);
  });

  it('falls back to generic metadata types when collaborators are unavailable at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('./program.service', () => ({}));
      jest.doMock('./flight.service', () => ({}));
      jest.doMock('../auth/realtime-ticket.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('./program.realtime.service') as {
        ProgramRealtimeService: typeof ProgramRealtimeService;
      };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          isolated.ProgramRealtimeService,
        ),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('./program.service');
    jest.dontMock('./flight.service');
    jest.dontMock('../auth/realtime-ticket.service');
  });
});
