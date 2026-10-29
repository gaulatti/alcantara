import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ObservabilityModule } from '../observability/observability.module';
import { PrismaService } from '../prisma.service';
import { ExternalSourceMetricsInterceptor } from './external-source-metrics.interceptor';
import { ExternalSourceSecurity } from './external-source.security';
import { ExternalSourcesController } from './external-sources.controller';
import { ExternalSourcesModule } from './external-sources.module';
import { ExternalSourcesService } from './external-sources.service';

describe('ExternalSourcesModule', () => {
  it('compiles and wires the controller, service, security and interceptor', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ObservabilityModule,
        ExternalSourcesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ externalSource: { findMany } })
      .compile();

    expect(moduleRef.get(ExternalSourceSecurity)).toBeInstanceOf(
      ExternalSourceSecurity,
    );
    expect(moduleRef.get(ExternalSourceMetricsInterceptor)).toBeInstanceOf(
      ExternalSourceMetricsInterceptor,
    );
    expect(moduleRef.get(ExternalSourcesService)).toBeInstanceOf(
      ExternalSourcesService,
    );
    const controller = moduleRef.get(ExternalSourcesController);
    await expect(
      controller.list({
        user: { sub: 's', authorization: { teamId: 3, permissions: [] } },
      }),
    ).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 3 } }),
    );
    await moduleRef.close();
  });
});
