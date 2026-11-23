import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PompeiiService } from '../auth/pompeii.service';
import { ObservabilityModule } from '../observability/observability.module';
import { PrismaService } from '../prisma.service';
import { ArtistLabelsController } from './artist-labels.controller';
import { ArtistLabelsModule } from './artist-labels.module';
import { ArtistLabelsService } from './artist-labels.service';

// PompeiiService comes from the global AuthModule in the application.
@Global()
@Module({
  providers: [{ provide: PompeiiService, useValue: { teamId: 0 } }],
  exports: [PompeiiService],
})
class PompeiiStubModule {}

describe('ArtistLabelsModule', () => {
  it('compiles and wires the controller and the service', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ObservabilityModule,
        PompeiiStubModule,
        ArtistLabelsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ artistLabel: { findMany } })
      .compile();
    expect(moduleRef.get(ArtistLabelsService)).toBeInstanceOf(
      ArtistLabelsService,
    );
    await expect(
      moduleRef.get(ArtistLabelsController).list({
        user: { authorization: { teamId: 0 } },
      }),
    ).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: null } }),
    );
  });
});
