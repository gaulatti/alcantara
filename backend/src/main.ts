import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const configuredPort = Number.parseInt(
    process.env.PORT ?? process.env.HTTP_PORT ?? '3000',
    10,
  );
  const port = Number.isNaN(configuredPort) ? 3000 : configuredPort;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (
        !origin ||
        origin === 'null' ||
        /^http:\/\/localhost:517\d$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:517\d$/.test(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(port, '0.0.0.0');
}
bootstrap();
