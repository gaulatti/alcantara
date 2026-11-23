import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PompeiiService } from '../auth/pompeii.service';
import { ObservabilityModule } from '../observability/observability.module';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from './alana.client';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsModule } from './broadcast-destinations.module';
import { BroadcastDestinationsService } from './broadcast-destinations.service';

// PompeiiService comes from the global AuthModule in the application.
@Global()
@Module({
  providers: [{ provide: PompeiiService, useValue: { teamId: 0 } }],
  exports: [PompeiiService],
})
class PompeiiStubModule {}

describe('BroadcastDestinationsModule', () => {
  it('compiles and wires the controller, service and Alana client', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ObservabilityModule,
        PompeiiStubModule,
        BroadcastDestinationsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ broadcastDestination: { findMany } })
      .compile();

    const controller = moduleRef.get(BroadcastDestinationsController);
    expect(moduleRef.get(AlanaClient)).toBeInstanceOf(AlanaClient);
    expect(moduleRef.get(BroadcastDestinationsService)).toBeInstanceOf(
      BroadcastDestinationsService,
    );
    await expect(
      controller.listDestinations({
        user: { sub: 'u', authorization: { teamId: 0 } },
      } as never),
    ).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
