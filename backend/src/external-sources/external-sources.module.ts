import { Module } from '@nestjs/common';
import { ExternalSourcesController } from './external-sources.controller';
import { ExternalSourceSecurity } from './external-source.security';
import { ExternalSourcesService } from './external-sources.service';
import { PrismaService } from '../prisma.service';
import { ExternalSourceMetricsInterceptor } from './external-source-metrics.interceptor';
import { ExternalSourcesMcpTools } from '../mcp/capabilities/external-sources';

@Module({
  controllers: [ExternalSourcesController],
  providers: [
    ExternalSourcesMcpTools,
    ExternalSourcesService,
    ExternalSourceSecurity,
    ExternalSourceMetricsInterceptor,
    PrismaService,
  ],
})
export class ExternalSourcesModule {}
