import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';

function build() {
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({ id: 10, radioSettings: null }),
    },
    radioSettings: {
      upsert: jest.fn().mockImplementation(async (arg) => arg),
    },
  };
  const palazzo: any = { validateBaseUrl: jest.fn((v: string) => v) };
  const config: any = { get: jest.fn() };
  const metrics: any = { recordListenerConfiguration: jest.fn() };
  const service = new RadioService(prisma, palazzo, config, metrics);
  return { service, prisma };
}

describe('RadioService similarity settings', () => {
  it('stores every valid similarity field on update and create', async () => {
    const { service, prisma } = build();
    await service.updateRadioSettings('p', {
      similarityMode: 'shadow',
      similarityPool: 'catalog',
      similarityThreshold: 0.5,
      similarityWindowSeconds: 30,
    });
    const arg = prisma.radioSettings.upsert.mock.calls[0][0];
    const expected = {
      similarityMode: 'shadow',
      similarityPool: 'catalog',
      similarityThreshold: 0.5,
      similarityWindowSeconds: 30,
    };
    expect(arg.update).toEqual(expected);
    expect(arg.create).toEqual(expect.objectContaining(expected));
  });

  it('accepts the inclusive threshold and window bounds', async () => {
    const { service, prisma } = build();
    await service.updateRadioSettings('p', {
      similarityThreshold: -1,
      similarityWindowSeconds: 5,
    });
    await service.updateRadioSettings('p', {
      similarityThreshold: 1,
      similarityWindowSeconds: 120,
    });
    expect(prisma.radioSettings.upsert.mock.calls[0][0].update).toEqual({
      similarityThreshold: -1,
      similarityWindowSeconds: 5,
    });
    expect(prisma.radioSettings.upsert.mock.calls[1][0].update).toEqual({
      similarityThreshold: 1,
      similarityWindowSeconds: 120,
    });
  });

  it.each([
    [
      'unknown mode',
      { similarityMode: 'loud' },
      'similarityMode must be off, shadow or on',
    ],
    [
      'unknown pool',
      { similarityPool: 'everything' },
      'similarityPool must be sequence or catalog',
    ],
    [
      'non-numeric threshold',
      { similarityThreshold: '0.5' },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      'non-finite threshold',
      { similarityThreshold: Number.NaN },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      'threshold below range',
      { similarityThreshold: -1.1 },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      'threshold above range',
      { similarityThreshold: 1.1 },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      'fractional window',
      { similarityWindowSeconds: 10.5 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
    [
      'window below range',
      { similarityWindowSeconds: 4 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
    [
      'window above range',
      { similarityWindowSeconds: 121 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
  ])('rejects %s without writing', async (_name, payload, message) => {
    const { service, prisma } = build();
    await expect(
      service.updateRadioSettings('p', payload as never),
    ).rejects.toThrow(new BadRequestException(message));
    expect(prisma.radioSettings.upsert).not.toHaveBeenCalled();
  });
});
