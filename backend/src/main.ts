import 'dotenv/config';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import type { Server as HttpServer } from 'http';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { corsOptions } from './cors';
import { ProgramRealtimeService } from './program/program.realtime.service';
import { loadRuntimeSecrets } from './config/runtime-secrets';
import { assertTestAuthSafety } from './auth/test-auth.service';
import { loadDatabaseSecret } from './config/database-secrets';
import { assertLocalMediaSafety } from './config/local-media';
import { isDeployCandidate } from './config/deploy-candidate';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { PlayoutLease } from './playout/playout-lease.service';
import {
  PlayoutHold,
  gateUpgrades,
  installPlayoutGate,
} from './playout/playout-gate';

async function bootstrap() {
  assertTestAuthSafety();
  await loadDatabaseSecret();
  await loadRuntimeSecrets();
  assertLocalMediaSafety();
  const configuredPort = Number.parseInt(
    process.env.PORT ?? process.env.HTTP_PORT ?? '3000',
    10,
  );
  const port = Number.isNaN(configuredPort) ? 3000 : configuredPort;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: 200 * 1024 * 1024,
    },
  });

  app.enableCors(corsOptions());
  // SIGTERM runs the shutdown hooks: streams end, in-flight requests finish and the playout lease is freed (#873).
  app.enableShutdownHooks();

  // A standby (alcantara#873) holds every request but the health checks and the scrape until it takes the playout
  // lease. A deploy candidate serves read-only and never holds.
  const lease = app.get(PlayoutLease);
  const hold = new PlayoutHold(lease, app.get(ManagedMetricsService));
  const candidate = isDeployCandidate();
  const fastify = app.getHttpAdapter().getInstance() as {
    addHook?: unknown;
  } | null;
  if (!candidate && typeof fastify?.addHook === 'function') {
    installPlayoutGate(fastify as never, hold);
  }

  await app.listen(port, '0.0.0.0');
  lease.start();

  const programRealtimeService = app.get(ProgramRealtimeService);
  const fastifyInstance = app.getHttpAdapter().getInstance() as {
    server?: HttpServer;
  };
  const upgradeServer =
    fastifyInstance?.server && typeof fastifyInstance.server.on === 'function'
      ? fastifyInstance.server
      : app.getHttpServer();
  programRealtimeService.attachToServer(
    (candidate
      ? upgradeServer
      : gateUpgrades(upgradeServer as never, hold)) as HttpServer,
  );
}
void bootstrap();
