import 'dotenv/config';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import type { Server as HttpServer } from 'http';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ProgramRealtimeService } from './program/program.realtime.service';
import { loadRuntimeSecrets } from './config/runtime-secrets';
import { validateProgramTemplateOrigins } from './config/runtime-secret-contract';
import { assertTestAuthSafety } from './auth/test-auth.service';
import { loadDatabaseSecret } from './config/database-secrets';
import { assertLocalMediaSafety } from './config/local-media';
import { MCP_PUBLIC_ORIGIN } from './mcp/mcp.constants';

function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (
    process.env.ALLOWED_ORIGINS ??
    process.env.FRONTEND_ORIGIN ??
    ''
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const templateOrigins = validateProgramTemplateOrigins(
    process.env.PROGRAM_TEMPLATE_ORIGINS ?? '',
  );

  return new Set<string>([
    // The API's own origin: the MCP consent page (gaulatti/bastille#34) is
    // served from it and posts its form back to it, and a same-origin request
    // is not a cross-origin one, so allowing it grants nothing new.
    MCP_PUBLIC_ORIGIN,
    'https://alcantara.gaulatti.com',
    'https://alcantara.dev',
    'https://alcantara.gt',
    'https://fifthbell.com',
    'https://cdn.fifthbell.com',
    ...configuredOrigins,
    ...templateOrigins,
  ]);
}

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

  const allowedOrigins = getAllowedOrigins();

  app.enableCors({
    origin: (origin, callback) => {
      if (
        !origin ||
        origin === 'null' ||
        allowedOrigins.has(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Renderer-Key',
    ],
  });

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
