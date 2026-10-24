/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AuthModule } from '../src/auth/auth.module';
import { Public } from '../src/auth/public.decorator';
import { AlanaClient } from '../src/broadcast-destinations/alana.client';
import { BroadcastDestinationsController } from '../src/broadcast-destinations/broadcast-destinations.controller';
import { BroadcastDestinationsService } from '../src/broadcast-destinations/broadcast-destinations.service';
import { ObservabilityModule } from '../src/observability/observability.module';
import { PrismaService } from '../src/prisma.service';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';

@Controller()
@Public()
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    AuthModule,
  ],
  controllers: [HealthController, BroadcastDestinationsController],
  providers: [BroadcastDestinationsService, AlanaClient, PrismaService],
})
class TestModule {}

describe('broadcast destination API contract (e2e)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let operatorToken: string;
  let viewerToken: string;
  let alanaOrigin: string;
  let fixture: ChildProcess | undefined;
  let prisma: PrismaService | undefined;
  const alanaToken = 'a'.repeat(64);
  const programId = 'destination-e2e';
  const environmentKeys = ['AUTH_MODE', 'TEST_AUTH_SECRET', 'ALANA_CONTROL_URL', 'ALANA_CONTROL_TOKEN'] as const;
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL ?? 'postgresql://missing');
    if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/alcantara_ci') {
      throw new Error('Broadcast destination e2e requires isolated local alcantara_ci PostgreSQL');
    }
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    alanaOrigin = `http://127.0.0.1:${port}`;
    fixture = spawn(process.execPath, [join(__dirname, 'fixtures/alana-recording-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), DESTINATION_PROGRAM_ID: programId, ALANA_CONTROL_TOKEN: alanaToken },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (fixture.exitCode !== null) throw new Error('Local Alana fixture exited before readiness');
      try { ready = (await fetch(`${alanaOrigin}/health`, { signal: AbortSignal.timeout(300) })).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (!ready) throw new Error('Local Alana fixture did not become ready');
    process.env.AUTH_MODE = 'test';
    process.env.TEST_AUTH_SECRET = 'alcantara-broadcast-e2e-local-only-signing-fixture';
    process.env.ALANA_CONTROL_URL = alanaOrigin;
    process.env.ALANA_CONTROL_TOKEN = alanaToken;
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    prisma = app.get(PrismaService);
    await prisma.programState.upsert({ where: { programId }, update: {}, create: { programId } });
    for (const [position, id] of ['primary', 'secondary'].entries()) {
      const destination = {
        displayName: `${id === 'primary' ? 'Primary' : 'Secondary'} rehearsal destination`,
        secretId: `broadcast/local/${id}`,
        secretVersionId: 'fictional-version-1', position, retiredAt: null,
      };
      await prisma.broadcastDestination.upsert({ where: { id }, update: destination, create: { id, ...destination } });
    }
    operatorToken = await session('operator-a');
    viewerToken = await session('viewer');
  }, 15_000);

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.broadcastDestinationCommand.deleteMany({ where: { programId } });
        await prisma.broadcastDestinationSelectionItem.deleteMany({ where: { selection: { programId } } });
        await prisma.broadcastDestinationSelection.deleteMany({ where: { programId } });
        await prisma.broadcastDestinationRuntime.deleteMany({ where: { programId } });
        await prisma.programState.deleteMany({ where: { programId } });
        await prisma.broadcastDestination.deleteMany({ where: { id: { in: ['primary', 'secondary'] } } });
      }
    } finally {
      await app?.close();
      if (fixture && fixture.exitCode === null) {
        const exited = once(fixture, 'exit');
        fixture.kill('SIGTERM');
        await exited;
      }
      for (const key of environmentKeys) {
        if (originalEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnvironment[key];
      }
    }
  });

  async function session(identity: string) {
    const response = await fetch(
      `${origin}/__test/session?identity=${identity}`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  async function api(path: string, token: string, init: RequestInit = {}) {
    return fetch(`${origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }

  it('separates view, operate, and manage permissions and redacts references', async () => {
    const stateResponse = await api('/broadcast/programs/destination-e2e', viewerToken);
    expect(stateResponse.status).toBe(200);
    const stateBody = JSON.stringify(await stateResponse.json());
    expect(stateBody).toContain('Primary rehearsal destination');
    expect(stateBody).not.toContain('broadcast/local/primary');
    expect(
      (await api('/broadcast/destinations/catalog', viewerToken)).status,
    ).toBe(403);
    expect(
      (
        await api('/broadcast/programs/destination-e2e/start', viewerToken, {
          method: 'POST',
          body: JSON.stringify({
            commandId: 'viewer-start',
            confirmed: true,
            destinationIds: ['primary'],
          }),
        })
      ).status,
    ).toBe(403);

    const catalogResponse = await api(
      '/broadcast/destinations/catalog',
      operatorToken,
    );
    expect(catalogResponse.status).toBe(200);
    expect(JSON.stringify(await catalogResponse.json())).toContain(
      'broadcast/local/primary',
    );
  });

  it('requires confirmation, reloads while stopped, starts exactly, and handles idempotency', async () => {
    expect(
      (
        await api('/broadcast/programs/destination-e2e/start', operatorToken, {
          method: 'POST',
          body: JSON.stringify({
            commandId: 'unconfirmed-start',
            confirmed: false,
            destinationIds: ['primary'],
          }),
        })
      ).status,
    ).toBe(400);

    const reloadResponse = await api(
      '/broadcast/programs/destination-e2e/reload',
      operatorToken,
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: 'reload-1',
          confirmed: true,
          destinationIds: ['primary'],
        }),
      },
    );
    expect(reloadResponse.status).toBe(201);
    const reload = (await reloadResponse.json()) as {
      selectionVersion: string;
    };
    expect((await api('/broadcast/programs/destination-e2e', viewerToken)).status).toBe(
      200,
    );

    const startRequest = {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'start-1',
        confirmed: true,
        destinationIds: ['primary'],
        selectionVersion: reload.selectionVersion,
      }),
    };
    const startResponse = await api(
      '/broadcast/programs/destination-e2e/start',
      operatorToken,
      startRequest,
    );
    expect(startResponse.status).toBe(201);
    const startBody = JSON.stringify(await startResponse.json());
    expect(startBody).toContain('succeeded');
    expect(startBody).not.toContain('broadcast/local/primary');

    const duplicate = await api(
      '/broadcast/programs/destination-e2e/start',
      operatorToken,
      startRequest,
    );
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const altered = await api('/broadcast/programs/destination-e2e/start', operatorToken, {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'start-1',
        confirmed: true,
        destinationIds: ['secondary'],
      }),
    });
    expect(altered.status).toBe(409);
  });

  it('keeps the active snapshot immutable, blocks active reload, and rejects later retired starts', async () => {
    const activeState = (await (
      await api('/broadcast/programs/destination-e2e', viewerToken)
    ).json()) as any;
    const activeVersion = activeState.downstream.activeDestinations.version;
    expect(
      (
        await api('/broadcast/programs/destination-e2e/reload', operatorToken, {
          method: 'POST',
          body: JSON.stringify({
            commandId: 'reload-active',
            confirmed: true,
            destinationIds: ['secondary'],
          }),
        })
      ).status,
    ).toBe(409);

    const catalog = (await (
      await api('/broadcast/destinations/catalog', operatorToken)
    ).json()) as any[];
    const primary = catalog.find((destination) => destination.id === 'primary');
    await api('/broadcast/destinations/primary', operatorToken, {
      method: 'PUT',
      body: JSON.stringify({
        ...primary,
        displayName: 'Edited after Start',
        secretVersionId: 'fictional-version-2',
      }),
    });
    await api('/broadcast/destinations/primary/retire', operatorToken, {
      method: 'POST',
    });
    const unchanged = (await (
      await api('/broadcast/programs/destination-e2e', viewerToken)
    ).json()) as any;
    expect(unchanged.downstream.activeDestinations.version).toBe(activeVersion);

    expect(
      (
        await api('/broadcast/programs/destination-e2e/stop', operatorToken, {
          method: 'POST',
          body: JSON.stringify({ commandId: 'stop-1', confirmed: true }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api('/broadcast/programs/destination-e2e/start', operatorToken, {
          method: 'POST',
          body: JSON.stringify({
            commandId: 'retired-start',
            confirmed: true,
            destinationIds: ['primary'],
          }),
        })
      ).status,
    ).toBe(400);
    await api('/broadcast/destinations/primary/restore', operatorToken, {
      method: 'POST',
    });
  });

  it('reports downstream partial acknowledgement as failure and reconciles without leaking references', async () => {
    await fetch(`${alanaOrigin}/__fixture/next-start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alanaToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'partial' }),
    });
    const response = await api(
      '/broadcast/programs/destination-e2e/start',
      operatorToken,
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: 'partial-start',
          confirmed: true,
          destinationIds: ['secondary'],
        }),
      },
    );
    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('exact destination selection');
    expect(body).not.toContain('broadcast/local/secondary');
    const reconciled = await api('/broadcast/programs/destination-e2e', viewerToken);
    expect(reconciled.status).toBe(200);
    expect(JSON.stringify(await reconciled.json())).not.toContain(
      'broadcast/local/secondary',
    );
    expect(
      (
        await api('/broadcast/programs/destination-e2e/stop', operatorToken, {
          method: 'POST',
          body: JSON.stringify({
            commandId: 'partial-cleanup-stop',
            confirmed: true,
          }),
        })
      ).status,
    ).toBe(201);
  });
});
