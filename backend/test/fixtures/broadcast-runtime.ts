import 'dotenv/config';
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AuthModule } from '../../src/auth/auth.module';
import { Public } from '../../src/auth/public.decorator';
import { AlanaClient } from '../../src/broadcast-destinations/alana.client';
import { BroadcastDestinationsController } from '../../src/broadcast-destinations/broadcast-destinations.controller';
import { BroadcastDestinationsService } from '../../src/broadcast-destinations/broadcast-destinations.service';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { PrismaService } from '../../src/prisma.service';

@Controller()
@Public()
class FixtureHealthController {
  @Get()
  health() {
    return { ok: true, fixture: 'broadcast-destinations' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    AuthModule,
  ],
  controllers: [FixtureHealthController, BroadcastDestinationsController],
  providers: [BroadcastDestinationsService, AlanaClient, PrismaService],
})
class BroadcastRuntimeModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    BroadcastRuntimeModule,
    new FastifyAdapter(),
  );
  app.enableCors({
    origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  await app.listen(Number(process.env.PORT ?? '3000'), '0.0.0.0');
}

void bootstrap();
