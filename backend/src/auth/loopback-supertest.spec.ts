import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { listenOnLoopback } from '../../test/loopback-supertest';

// The supertest servers listen on 127.0.0.1 only, so a port another process
// holds there can never be handed to them (gaulatti/alcantara#310).
describe('listenOnLoopback', () => {
  let server: Server;
  beforeEach(() => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ local: req.socket.localAddress }));
    });
  });
  afterEach(() => {
    server.close();
  });

  it('listens on 127.0.0.1 and supertest is answered from there', async () => {
    await listenOnLoopback(server);
    expect((server.address() as { address: string }).address).toBe('127.0.0.1');
    const response = await request(server).get('/');
    expect(response.body).toEqual({ local: '127.0.0.1' });
  });

  it('leaves an already listening server alone', async () => {
    await listenOnLoopback(server);
    const before = server.address();
    await listenOnLoopback(server);
    expect(server.address()).toEqual(before);
  });

  it('reports a bind failure instead of hanging', async () => {
    jest.spyOn(server, 'listen').mockImplementation(() => {
      server.emit('error', new Error('bind failed'));
      return server;
    });
    await expect(listenOnLoopback(server)).rejects.toThrow('bind failed');
  });
});
