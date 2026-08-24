import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';

describe('RadioService settings', () => {
  it('persists every bumper field exposed by the radio console', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: {
        upsert: jest.fn().mockImplementation(({ update }) => update),
      },
    } as any;
    const service = new RadioService(prisma);

    const result = await service.updateRadioSettings('palazzo', {
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4, 8],
      bumperMode: 'random',
    });

    expect(result).toMatchObject({
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4],
      bumperMode: 'random',
    });
  });

  it('rejects an invalid bumper interval', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: { upsert: jest.fn() },
    } as any;
    const service = new RadioService(prisma);
    await expect(
      service.updateRadioSettings('palazzo', { bumperInterval: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
