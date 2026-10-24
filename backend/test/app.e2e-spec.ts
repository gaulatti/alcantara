import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';

describe('compiled Fastify entry point and local authorization (PostgreSQL e2e)', () => {
  let child: ChildProcess | undefined;
  let origin: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const database = new URL(databaseUrl ?? 'postgresql://missing');
    if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/alcantara_ci') {
      throw new Error('Application e2e requires isolated local alcantara_ci PostgreSQL');
    }
    // Exercise Node's production loader and compiled entry point, including
    // native ESM dependencies, without substituting application providers.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(__dirname, '../dist/src/main.js')], {
      cwd: join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        AUTH_MODE: 'test',
        TEST_AUTH_SECRET: 'alcantara-e2e-local-only-signing-fixture-key',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostic = '';
    child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Native application exited before readiness (${child.exitCode}): ${diagnostic}`);
      try {
        const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(300) });
        if (response.ok) return;
      } catch {
        // The child has not bound its disposable local port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Native application did not become ready: ${diagnostic}`);
  }, 25_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  });

  it('starts the actual entry point and serves the public health endpoint with the production HTTP adapter', async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello World!');
  });

  it('keeps authenticated Program reads behind the real global guard', async () => {
    const response = await fetch(`${origin}/program`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: 'Bearer token required' });
  });

  it('issues a supported local session and carries its token through the guard and PostgreSQL-backed Program API', async () => {
    const session = await fetch(`${origin}/__test/session?identity=operator-a`);
    expect(session.status).toBe(200);
    const { accessToken, user } = await session.json() as { accessToken: string; user: { id: string } };
    expect(user.id).toBe('test:alcantara:operator-a');
    const response = await fetch(`${origin}/program`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ programId: 'main' })]));
  });

  it('rejects forged credentials and denies viewer Program mutations without granting operator authority', async () => {
    const forged = await fetch(`${origin}/program`, { headers: { authorization: 'Bearer invalid-local-token' } });
    expect(forged.status).toBe(401);
    const session = await fetch(`${origin}/__test/session?identity=viewer`);
    const { accessToken } = await session.json() as { accessToken: string };
    const response = await fetch(`${origin}/program`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ programId: 'not-authorized' }),
    });
    expect(response.status).toBe(403);
  });
});
