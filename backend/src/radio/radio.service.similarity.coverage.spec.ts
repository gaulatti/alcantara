import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';

type Normalizer = {
  normalizeSimilarityPayload(data: Record<string, unknown>): unknown;
};

function normalize(data: Record<string, unknown>) {
  const service = new RadioService(
    {} as any,
    {} as any,
    { get: jest.fn() } as any,
    {} as any,
    { teamId: 0 } as never,
  );
  return (service as unknown as Normalizer).normalizeSimilarityPayload(data);
}

describe('RadioService similarity payload', () => {
  it('leaves absent fields untouched', () => {
    expect(normalize({})).toEqual({});
  });

  it('passes valid fields through', () => {
    expect(
      normalize({
        similarityMode: 'shadow',
        similarityPool: 'catalog',
        similarityThreshold: -1,
        similarityWindowSeconds: 120,
      }),
    ).toEqual({
      similarityMode: 'shadow',
      similarityPool: 'catalog',
      similarityThreshold: -1,
      similarityWindowSeconds: 120,
    });
    expect(
      normalize({ similarityThreshold: 1, similarityWindowSeconds: 5 }),
    ).toEqual({ similarityThreshold: 1, similarityWindowSeconds: 5 });
  });

  it.each([
    [{ similarityMode: 'loud' }, 'similarityMode must be off, shadow or on'],
    [{ similarityPool: 'all' }, 'similarityPool must be sequence or catalog'],
    [
      { similarityThreshold: '0.5' },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      { similarityThreshold: Number.NaN },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      { similarityThreshold: -1.01 },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      { similarityThreshold: 1.01 },
      'similarityThreshold must be between -1 and 1',
    ],
    [
      { similarityWindowSeconds: 30.5 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
    [
      { similarityWindowSeconds: 4 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
    [
      { similarityWindowSeconds: 121 },
      'similarityWindowSeconds must be an integer between 5 and 120',
    ],
  ])('rejects %j', (data, message) => {
    expect(() => normalize(data)).toThrow(new BadRequestException(message));
  });
});
