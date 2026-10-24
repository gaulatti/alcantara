import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ProgramRealtimeService } from './program.realtime.service';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Realtime expectation was not delivered');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('ProgramRealtimeService actual WebSocket boundary', () => {
  let server: Server;
  let service: ProgramRealtimeService;
  let baseUrl: string;
  let sockets: WebSocket[];
  let listener: (event: any) => void;
  let programs: any;
  let flights: any;
  let tickets: RealtimeTicketService;
  let unsubscribe: jest.Mock;

  beforeEach(async () => {
    sockets = [];
    unsubscribe = jest.fn();
    programs = {
      addEventListener: jest.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
      getState: jest.fn().mockResolvedValue({ version: 1, activeSceneId: 7 }),
      getProgramAudioBus: jest
        .fn()
        .mockResolvedValue({ version: 2, volume: 0.5 }),
      getBroadcastSettings: jest
        .fn()
        .mockResolvedValue({ version: 3, enabled: true }),
      getProgramAudioMeter: jest
        .fn()
        .mockResolvedValue({ version: 4, main: { vu: 0.4 } }),
      getProgramSongPlayback: jest
        .fn()
        .mockResolvedValue({ version: 5, token: 'song-1' }),
      getProgramSceneInstantPlayback: jest
        .fn()
        .mockResolvedValue({ version: 6, token: 'instant-1' }),
      updateProgramAudioMeter: jest.fn(),
      updateProgramSongPlayback: jest.fn(),
    };
    flights = { handleSongEnded: jest.fn() };
    tickets = new RealtimeTicketService();
    service = new ProgramRealtimeService(programs, flights, tickets);
    server = createServer();
    service.attachToServer(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jest.restoreAllMocks();
  });

  async function connect(role: 'control' | 'program', programId = 'main') {
    const token = role === 'control' ? tickets.issue(programId).ticket : '';
    const socket = new WebSocket(
      `${baseUrl}/program/ws?role=${role}&programId=${encodeURIComponent(programId)}&ticket=${token}`,
    );
    sockets.push(socket);
    const packets: any[] = [];
    socket.on('message', (data) => packets.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    if (role === 'control') await until(() => packets.length === 6);
    return { socket, packets };
  }

  async function rejected(query: string): Promise<number> {
    const socket = new WebSocket(`${baseUrl}/program/ws?${query}`);
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        const status = response.statusCode!;
        response.resume();
        socket.terminate();
        resolve(status);
      });
      socket.once('open', () =>
        reject(new Error('Unauthorized realtime upgrade succeeded')),
      );
      socket.on('error', () => undefined);
    });
  }

  it('requires a known role and a single-use ticket bound to the requested control program', async () => {
    expect(await rejected('role=unknown')).toBe(400);
    expect(await rejected('role=control')).toBe(401);
    const wrong = tickets.issue('news').ticket;
    expect(
      await rejected(`role=control&programId=sports&ticket=${wrong}`),
    ).toBe(401);
    expect(await rejected(`role=control&programId=news&ticket=${wrong}`)).toBe(
      401,
    );
    const connected = await connect('control', 'news');
    expect(connected.packets).toHaveLength(6);
    expect(programs.getState).toHaveBeenCalledWith('news');
  });

  it('sends all versioned operator snapshots only to an authenticated control client', async () => {
    const control = await connect('control', 'news');
    const renderer = await connect('program', 'news');
    expect(
      control.packets.map((packet) => [packet.type, packet.version]),
    ).toEqual([
      ['program_state_snapshot', 1],
      ['audio_bus_snapshot', 2],
      ['broadcast_settings_snapshot', 3],
      ['audio_meter_update', 4],
      ['song_playback_update', 5],
      ['scene_instant_state', 6],
    ]);
    expect(
      control.packets.find((packet) => packet.type === 'program_state_snapshot')
        .state.activeSceneId,
    ).toBe(7);
    expect(renderer.packets).toEqual([]);
    expect(programs.getState).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'not-an-object', {}, { version: 'invalid' }])(
    'does not invent versions for unversioned snapshots: %p',
    async (value) => {
      for (const key of [
        'getState',
        'getProgramAudioBus',
        'getBroadcastSettings',
        'getProgramAudioMeter',
        'getProgramSongPlayback',
        'getProgramSceneInstantPlayback',
      ]) {
        programs[key].mockResolvedValue(value);
      }
      const control = await connect('control');
      expect(
        control.packets.every(
          (packet) => !Object.prototype.hasOwnProperty.call(packet, 'version'),
        ),
      ).toBe(true);
    },
  );

  it('isolates snapshot failures while leaving the control connection able to receive later events', async () => {
    for (const key of [
      'getState',
      'getProgramAudioBus',
      'getBroadcastSettings',
      'getProgramAudioMeter',
      'getProgramSongPlayback',
      'getProgramSceneInstantPlayback',
    ]) {
      programs[key].mockRejectedValue(new Error('snapshot unavailable'));
    }
    const token = tickets.issue('main').ticket;
    const socket = new WebSocket(
      `${baseUrl}/program/ws?role=control&ticket=${token}`,
    );
    sockets.push(socket);
    const packets: any[] = [];
    socket.on('message', (data) => packets.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await until(
      () => programs.getProgramSceneInstantPlayback.mock.calls.length === 1,
    );
    listener({
      scope: 'global',
      programId: null,
      data: { type: 'broadcast_settings_changed' },
    });
    await until(() => packets.length === 1);
    expect(packets).toEqual([{ type: 'broadcast_settings_changed' }]);
  });

  it('accepts bounded renderer telemetry and completion, ignoring malformed and unknown messages', async () => {
    const renderer = await connect('program', 'news');
    for (const invalid of ['', 'not JSON', 'null', '17', '{"type":"unknown"}'])
      renderer.socket.send(invalid);
    renderer.socket.send(
      JSON.stringify({
        type: 'audio_meter_update',
        levels: { main: { vu: 0.4 } },
      }),
    );
    renderer.socket.send(
      JSON.stringify({
        type: 'song_playback_update',
        playback: { token: 'song-1', currentTimeMs: 100 },
      }),
    );
    renderer.socket.send(JSON.stringify({ type: 'song_ended' }));
    await until(() => flights.handleSongEnded.mock.calls.length === 1);
    expect(programs.updateProgramAudioMeter).toHaveBeenCalledTimes(1);
    expect(programs.updateProgramAudioMeter).toHaveBeenCalledWith(
      { main: { vu: 0.4 } },
      'news',
    );
    expect(programs.updateProgramSongPlayback).toHaveBeenCalledWith(
      { token: 'song-1', currentTimeMs: 100 },
      'news',
    );
    expect(flights.handleSongEnded).toHaveBeenCalledWith('news');
    expect(renderer.packets).toEqual([]);
  });

  it('accepts flat telemetry and isolates malformed downstream updates from the next valid message', async () => {
    const renderer = await connect('program', '');
    programs.updateProgramAudioMeter.mockRejectedValueOnce(
      new Error('invalid meter'),
    );
    programs.updateProgramSongPlayback.mockRejectedValueOnce(
      new Error('invalid playback'),
    );
    flights.handleSongEnded.mockRejectedValueOnce(
      new Error('flight unavailable'),
    );
    renderer.socket.send(
      JSON.stringify({
        type: 'audio_meter_update',
        levels: null,
        main: { vu: 1 },
      }),
    );
    renderer.socket.send(
      JSON.stringify({
        type: 'song_playback_update',
        playback: null,
        token: 'song-1',
      }),
    );
    renderer.socket.send(JSON.stringify({ type: 'song_ended' }));
    renderer.socket.send(JSON.stringify({ type: 'song_ended' }));
    await until(() => flights.handleSongEnded.mock.calls.length === 2);
    expect(programs.updateProgramAudioMeter).toHaveBeenCalledWith(
      { type: 'audio_meter_update', levels: null, main: { vu: 1 } },
      'main',
    );
    expect(programs.updateProgramSongPlayback).toHaveBeenCalledWith(
      { type: 'song_playback_update', playback: null, token: 'song-1' },
      'main',
    );
    expect(console.error).toHaveBeenCalledWith('[WS] song_ended handler threw');
    expect(renderer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('does not let operator clients impersonate renderer meter, playback or song completion events', async () => {
    const control = await connect('control', 'news');
    control.socket.send(
      JSON.stringify({
        type: 'audio_meter_update',
        levels: { main: { vu: 1 } },
      }),
    );
    control.socket.send(
      JSON.stringify({
        type: 'song_playback_update',
        playback: { token: 'forged' },
      }),
    );
    control.socket.send(JSON.stringify({ type: 'song_ended' }));
    await until(() =>
      (console.log as jest.Mock).mock.calls.some((call) =>
        String(call[0]).includes('song_ended ignored'),
      ),
    );
    expect(programs.updateProgramAudioMeter).not.toHaveBeenCalled();
    expect(programs.updateProgramSongPlayback).not.toHaveBeenCalled();
    expect(flights.handleSongEnded).not.toHaveBeenCalled();
  });

  it('routes scoped events only to matching operators and global events to all operators, never renderers', async () => {
    const news = await connect('control', 'news');
    const sports = await connect('control', 'sports');
    const renderer = await connect('program', 'news');
    news.packets.length = 0;
    sports.packets.length = 0;
    listener({ scope: 'program', programId: null, data: { type: 'ignored' } });
    listener({
      scope: 'program',
      programId: ' news ',
      data: { type: 'scene_update', sceneId: 7 },
    });
    listener({ scope: 'program', programId: 'news', data: ['legacy-event'] });
    listener({
      scope: 'program',
      programId: 'news',
      data: { type: 'already-scoped', programId: 'news' },
    });
    listener({
      scope: 'global',
      programId: null,
      data: { type: 'broadcast_settings_update' },
    });
    await until(() => news.packets.length === 4 && sports.packets.length === 1);
    expect(news.packets).toEqual([
      { type: 'scene_update', sceneId: 7, programId: 'news' },
      { type: 'program_event', programId: 'news', payload: ['legacy-event'] },
      { type: 'already-scoped', programId: 'news' },
      { type: 'broadcast_settings_update' },
    ]);
    expect(sports.packets).toEqual([{ type: 'broadcast_settings_update' }]);
    expect(renderer.packets).toEqual([]);
  });

  it('delivers program telemetry broadcasts to operators and renderers without crossing program boundaries', async () => {
    const news = await connect('control', 'news');
    const sports = await connect('control', 'sports');
    const renderer = await connect('program', 'news');
    news.packets.length = 0;
    sports.packets.length = 0;
    const meter = { main: { vu: 0.1 } } as any;
    const playback = { token: 'song-1' } as any;
    service.broadcastAudioMeterUpdate(' news ', meter);
    service.broadcastSongPlaybackUpdate('news', playback);
    await until(
      () => news.packets.length === 2 && renderer.packets.length === 2,
    );
    expect(news.packets).toEqual([
      { type: 'audio_meter_update', programId: 'news', levels: meter },
      { type: 'song_playback_update', programId: 'news', playback },
    ]);
    expect(renderer.packets).toEqual(news.packets);
    expect(sports.packets).toEqual([]);
  });

  it('attaches idempotently, cleans up connections and unregisters its event subscription exactly once', async () => {
    service.attachToServer(server);
    expect(server.listeners('upgrade')).toHaveLength(1);
    const renderer = await connect('program');
    service.onModuleDestroy();
    service.onModuleDestroy();
    await until(() => renderer.socket.readyState === WebSocket.CLOSED);
    expect(server.listeners('upgrade')).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
