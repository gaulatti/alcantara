import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongsModule } from './songs.module';
import { SongsService } from './songs.service';

describe('SongsModule', () => {
  it('wires the controller to the service and prisma', async () => {
    const prisma = {
      song: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [SongsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(SongsService)).toBeInstanceOf(SongsService);
    await expect(moduleRef.get(SongsController).findOne('5')).rejects.toThrow(
      'Song not found',
    );
    expect(prisma.song.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } }),
    );
    await moduleRef.close();
  });
});
