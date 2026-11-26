/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed HTTP and tool bodies are untyped */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { z } from 'zod';
import { AuthModule } from '../auth/auth.module';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { McpToolProvider, type McpToolSpec } from '../mcp/contract';
import { McpRegistry } from '../mcp/mcp-registry.service';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { ProgramService } from '../program/program.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

const team = 910_000 + (process.pid % 10_000);
const prefix = `programs-gate-${randomUUID()}`;
const mine = `${prefix}-mine`;
const other = `${prefix}-other`;
const nobody = `${prefix}-nobody`;
const permission = ALCANTARA_PERMISSIONS.program.read;

@Controller()
class RoutesController {
  @Get('program/:programId/state')
  @RequirePermission(permission)
  state(@Param('programId') programId: string) {
    return { programId };
  }

  @Get('instants')
  @RequirePermission(permission)
  list() {
    return { ok: true };
  }

  @Post('instants/stop-all')
  @RequirePermission(permission)
  stop() {
    return { ok: true };
  }

  @Post('program/off-air')
  @RequirePermission(permission)
  offAir() {
    return { ok: true };
  }

  @Post('program')
  @RequirePermission(permission)
  create() {
    return { ok: true };
  }

  @Post('auth/other-ticket')
  @RequirePermission(permission)
  ticket() {
    return { ok: true };
  }

  @Get('open/:programId')
  @Public()
  open() {
    return { ok: true };
  }
}

@McpToolProvider()
@Injectable()
class ProbeTools {
  specs(): McpToolSpec[] {
    return [
      {
        name: 'probe_program',
        title: 'Probe',
        description: 'Probe',
        permission,
        tier: 'R',
        firstClass: true,
        shape: { program_id: z.string() },
        run: () => Promise.resolve({ result: { ok: true }, audit: {} }),
      },
    ];
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ObservabilityModule,
    AuthModule,
    DiscoveryModule,
  ],
  controllers: [RoutesController],
  providers: [
    McpRegistry,
    ProbeTools,
    { provide: ProgramService, useValue: {} },
  ],
})
class RoutesModule {}

// gaulatti/alcantara#122: through the real guards, HTTP stack and Postgres.
describe("programs of the caller's team", () => {
  const environment = { ...process.env };
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;
  let ownedMain: { teamId: number | null } | null;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    process.env.AUTH_MODE = 'test';
    process.env.TEST_AUTH_SECRET = 'test-secret-test-secret-test-secret-00';
    process.env.POMPEII_TEAM_ID = String(team);
    prisma = new PrismaService();
    await prisma.$connect();
    ownedMain = await prisma.program.findUnique({
      where: { programId: 'main' },
      select: { teamId: true },
    });
    for (const [programId, teamId] of [
      [mine, team],
      [other, team + 1],
      [nobody, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId } });
    }
    const module = await Test.createTestingModule({
      imports: [RoutesModule],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = (await app.inject({ method: 'GET', url: '/__test/session' })).json()
      .accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.program.deleteMany({
      where: { programId: { in: [mine, other, nobody] } },
    });
    if (!ownedMain) {
      await prisma?.program.deleteMany({ where: { programId: 'main' } });
    }
    await prisma?.$disconnect();
    process.env = environment;
  });

  const call = async (method: 'GET' | 'POST', url: string, body?: object) =>
    (
      await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body ? { payload: body } : {}),
      })
    ).statusCode;

  it("answers for the team's program, and 404 for another team's, by path, query and body", async () => {
    await expect(call('GET', `/program/${mine}/state`)).resolves.toBe(200);
    await expect(call('GET', `/program/${other}/state`)).resolves.toBe(404);
    await expect(call('GET', `/instants?programId=${mine}`)).resolves.toBe(200);
    await expect(call('GET', `/instants?programId=${other}`)).resolves.toBe(
      404,
    );
    await expect(
      call('POST', '/instants/stop-all', { programId: mine }),
    ).resolves.toBe(201);
    await expect(
      call('POST', '/instants/stop-all', { programId: other }),
    ).resolves.toBe(404);
    await expect(call('GET', '/instants')).resolves.toBe(200);
  });

  it('keeps a program nobody owns, or not yet created, usable', async () => {
    await expect(call('GET', `/program/${nobody}/state`)).resolves.toBe(200);
    await expect(call('GET', `/program/${prefix}-new/state`)).resolves.toBe(
      200,
    );
    await expect(call('POST', '/program', { programId: other })).resolves.toBe(
      201,
    );
    await expect(call('GET', `/open/${other}`)).resolves.toBe(200);
  });

  it('checks main on a route that names no program', async () => {
    await prisma.program.upsert({
      where: { programId: 'main' },
      create: { programId: 'main', teamId: team + 1 },
      update: { teamId: team + 1 },
    });
    await expect(call('POST', '/program/off-air')).resolves.toBe(404);
    await prisma.program.update({
      where: { programId: 'main' },
      data: { teamId: team },
    });
    await expect(call('POST', '/program/off-air')).resolves.toBe(201);
    if (ownedMain) {
      await prisma.program.update({
        where: { programId: 'main' },
        data: { teamId: ownedMain.teamId },
      });
    }
  });

  it("refuses an MCP tool another team's program", async () => {
    const handlers = new Map<string, (args: object) => Promise<any>>();
    const principal = {
      subject: 'tester',
      principalId: 'p',
      client: 'test',
      permissions: new Set([permission]),
    };
    app.get(McpRegistry).register(
      {
        registerTool: (name: string, _config: unknown, handler: never) =>
          handlers.set(name, handler),
      } as never,
      principal as never,
      (() => Promise.resolve(principal)) as never,
    );
    const run = async (programId: string) =>
      JSON.parse(
        (await handlers.get('probe_program')!({ program_id: programId }))
          .content[0].text,
      );
    await expect(run(mine)).resolves.toEqual({ ok: true });
    await expect(run(other)).resolves.toMatchObject({ error: 'not_found' });
  });

  it('counts refused and unowned', async () => {
    const rendered = await app.get(ManagedMetricsService).registry.metrics();
    for (const result of ['refused', 'unowned']) {
      expect(rendered).toMatch(
        new RegExp(
          `alcantara_program_team_checks_total\\{result="${result}"\\} [1-9]`,
        ),
      );
    }
  });

  it('names only routes the application has', () => {
    const inventory = readFileSync(
      join(__dirname, '../api-surface/route-inventory.json'),
      'utf8',
    );
    for (const route of [
      '/program/activate',
      '/program/off-air',
      '/program/song/off-air',
      '/program/reload',
      '/auth/realtime-ticket',
      '/program',
    ]) {
      expect(inventory).toContain(`"${route}"`);
    }
  });
});
