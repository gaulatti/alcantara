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

  await app.listen(port, '0.0.0.0');

  const programRealtimeService = app.get(ProgramRealtimeService);
  const fastifyInstance = app.getHttpAdapter().getInstance() as {
    server?: HttpServer;
  };
  const upgradeServer =
    fastifyInstance?.server && typeof fastifyInstance.server.on === 'function'
      ? fastifyInstance.server
      : app.getHttpServer();
  programRealtimeService.attachToServer(upgradeServer as HttpServer);
}
void bootstrap();
