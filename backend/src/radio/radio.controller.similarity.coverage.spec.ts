import { BadRequestException } from '@nestjs/common';
import { RadioController } from './radio.controller';

function build() {
  const radio = {
    getRadioSettings: jest.fn().mockResolvedValue({ enabled: true }),
    updateRadioSettings: jest.fn().mockResolvedValue({ enabled: true }),
  };
  const telemetry = { handleRadioSettingsChanged: jest.fn() };
  const similarity = {
    getCoverage: jest.fn().mockResolvedValue({ covered: 3 }),
    listDecisions: jest.fn().mockResolvedValue([{ id: 1 }]),
    exportSongs: jest.fn().mockResolvedValue([{ songId: 7 }]),
    storeEmbeddings: jest.fn().mockResolvedValue({ stored: 2 }),
    onSettingsChanged: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new RadioController(
    radio as any,
    {} as any,
    {} as any,
    telemetry as any,
    {} as any,
    similarity as any,
  );
  return { controller, radio, telemetry, similarity };
}

describe('RadioController similarity coverage', () => {
  it('returns embedding coverage for the program', async () => {
    const { controller, similarity } = build();
    await expect(controller.similarityCoverage('p')).resolves.toEqual({
      covered: 3,
    });
    expect(similarity.getCoverage).toHaveBeenCalledWith('p');
  });

  it('lists decisions with the requested limit, defaulting to 50', async () => {
    const { controller, similarity } = build();
    await expect(controller.similarityDecisions('p', '12')).resolves.toEqual([
      { id: 1 },
    ]);
    expect(similarity.listDecisions).toHaveBeenLastCalledWith('p', 12);
    await controller.similarityDecisions('p');
    expect(similarity.listDecisions).toHaveBeenLastCalledWith('p', 50);
  });

  it('exports songs for a valid scope and passes the missing-only flag', async () => {
    const { controller, similarity } = build();
    await expect(
      controller.similarityExport('p', 'sequence', 'true'),
    ).resolves.toEqual([{ songId: 7 }]);
    expect(similarity.exportSongs).toHaveBeenLastCalledWith(
      'p',
      'sequence',
      true,
    );
    await controller.similarityExport('p', 'catalog');
    expect(similarity.exportSongs).toHaveBeenLastCalledWith(
      'p',
      'catalog',
      false,
    );
  });

  it('rejects an export without a valid scope', async () => {
    const { controller, similarity } = build();
    await expect(
      controller.similarityExport('p', 'everything'),
    ).rejects.toThrow(
      new BadRequestException('scope must be sequence or catalog'),
    );
    await expect(controller.similarityExport('p')).rejects.toThrow(
      BadRequestException,
    );
    expect(similarity.exportSongs).not.toHaveBeenCalled();
  });

  it('stores uploaded embeddings', async () => {
    const { controller, similarity } = build();
    const body = { embeddings: [] };
    await expect(controller.similarityUpload('p', body)).resolves.toEqual({
      stored: 2,
    });
    expect(similarity.storeEmbeddings).toHaveBeenCalledWith(body, 'p');
  });

  it.each([
    ['similarityMode', { similarityMode: 'shadow' }],
    ['similarityThreshold', { similarityThreshold: 0.5 }],
    ['similarityWindowSeconds', { similarityWindowSeconds: 30 }],
    ['similarityPool', { similarityPool: 'catalog' }],
  ])('reloads similarity settings when %s changes', async (_field, data) => {
    const { controller, similarity, telemetry } = build();
    await controller.updateSettings('p', data as any);
    expect(similarity.onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(telemetry.handleRadioSettingsChanged).not.toHaveBeenCalled();
  });

  it('does not reload similarity settings for unrelated changes', async () => {
    const { controller, similarity } = build();
    await controller.updateSettings('p', { enabled: true } as any);
    expect(similarity.onSettingsChanged).not.toHaveBeenCalled();
  });
});
