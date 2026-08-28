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
  const alanaOrigin = process.env.ALANA_CONTROL_URL ?? 'http://alana:8080';
  const alanaToken =
    process.env.ALANA_CONTROL_TOKEN ?? 'alana-local-control-token';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    operatorToken = await session('operator-a');
    viewerToken = await session('viewer');
  });

  afterAll(async () => {
    await app.close();
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
    const stateResponse = await api('/broadcast/programs/main', viewerToken);
    expect(stateResponse.status).toBe(200);
    const stateBody = JSON.stringify(await stateResponse.json());
    expect(stateBody).toContain('Primary rehearsal destination');
    expect(stateBody).not.toContain('broadcast/local/primary');
    expect(
      (await api('/broadcast/destinations/catalog', viewerToken)).status,
    ).toBe(403);
    expect(
      (
        await api('/broadcast/programs/main/start', viewerToken, {
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
        await api('/broadcast/programs/main/start', operatorToken, {
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
      '/broadcast/programs/main/reload',
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
    expect((await api('/broadcast/programs/main', viewerToken)).status).toBe(
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
      '/broadcast/programs/main/start',
      operatorToken,
      startRequest,
    );
    expect(startResponse.status).toBe(201);
    const startBody = JSON.stringify(await startResponse.json());
    expect(startBody).toContain('succeeded');
    expect(startBody).not.toContain('broadcast/local/primary');

    const duplicate = await api(
      '/broadcast/programs/main/start',
      operatorToken,
      startRequest,
    );
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const altered = await api('/broadcast/programs/main/start', operatorToken, {
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
      await api('/broadcast/programs/main', viewerToken)
    ).json()) as any;
    const activeVersion = activeState.downstream.activeDestinations.version;
    expect(
      (
        await api('/broadcast/programs/main/reload', operatorToken, {
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
      await api('/broadcast/programs/main', viewerToken)
    ).json()) as any;
    expect(unchanged.downstream.activeDestinations.version).toBe(activeVersion);

    expect(
      (
        await api('/broadcast/programs/main/stop', operatorToken, {
          method: 'POST',
          body: JSON.stringify({ commandId: 'stop-1', confirmed: true }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api('/broadcast/programs/main/start', operatorToken, {
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
      '/broadcast/programs/main/start',
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
    const reconciled = await api('/broadcast/programs/main', viewerToken);
    expect(reconciled.status).toBe(200);
    expect(JSON.stringify(await reconciled.json())).not.toContain(
      'broadcast/local/secondary',
    );
    expect(
      (
        await api('/broadcast/programs/main/stop', operatorToken, {
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
