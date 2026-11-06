import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { MediaAssetsController } from './media-assets.controller';
import { MediaAssetsModule } from './media-assets.module';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';
import { MediaAssetsService } from './media-assets.service';

const authorization = { permissions: ['*'] };
const request = { user: { authorization } };

function build() {
  const service = {
    findAll: jest.fn().mockReturnValue('findAll'),
    findOne: jest.fn().mockReturnValue('findOne'),
    createBackgroundAudio: jest.fn().mockReturnValue('createBackgroundAudio'),
    removeStandaloneAsset: jest.fn().mockReturnValue('removeStandaloneAsset'),
    replaceAssetLabels: jest.fn().mockReturnValue('replaceAssetLabels'),
    findLabels: jest.fn().mockReturnValue('findLabels'),
    resolveLabelImages: jest.fn().mockReturnValue('resolveLabelImages'),
    findLabel: jest.fn().mockReturnValue('findLabel'),
    createLabel: jest.fn().mockReturnValue('createLabel'),
    updateLabel: jest.fn().mockReturnValue('updateLabel'),
    replaceLabelAssets: jest.fn().mockReturnValue('replaceLabelAssets'),
    removeLabel: jest.fn().mockReturnValue('removeLabel'),
  };
  return { controller: new MediaAssetsController(service as never), service };
}

describe('MediaAssetsController (coverage)', () => {
  it('findAll applies default pagination', () => {
    const { controller, service } = build();
    expect(controller.findAll(request)).toBe('findAll');
    expect(service.findAll).toHaveBeenCalledWith(
      {
        search: undefined,
        mediaType: undefined,
        capability: undefined,
        labelId: undefined,
        page: 1,
        limit: 50,
      },
      authorization,
    );
  });

  it('findAll forwards filters and clamps page and limit', () => {
    const { controller, service } = build();
    controller.findAll(request, 's', 'IMAGE', 'SONG', 'l', '-3', '1000');
    controller.findAll(
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      '7',
      '0',
    );
    expect(service.findAll.mock.calls.map((c) => c[0])).toEqual([
      {
        search: 's',
        mediaType: 'IMAGE',
        capability: 'SONG',
        labelId: 'l',
        page: 1,
        limit: 200,
      },
      {
        search: undefined,
        mediaType: undefined,
        capability: undefined,
        labelId: undefined,
        page: 7,
        limit: 1,
      },
    ]);
  });

  it('findLabels applies default and clamped pagination', () => {
    const { controller, service } = build();
    expect(controller.findLabels(request)).toBe('findLabels');
    controller.findLabels(request, 'q', '0', '500');
    controller.findLabels(request, undefined, '3', '0');
    expect(service.findLabels.mock.calls).toEqual([
      [{ search: undefined, page: 1, limit: 50 }, authorization],
      [{ search: 'q', page: 1, limit: 200 }, authorization],
      [{ search: undefined, page: 3, limit: 1 }, authorization],
    ]);
  });

  it('delegates asset operations with the request authorization', () => {
    const { controller, service } = build();
    expect(controller.findOne('a', request)).toBe('findOne');
    expect(service.findOne).toHaveBeenCalledWith('a', authorization);

    const body = { name: 'n', sourceUrl: 'u', defaultVolume: 1 };
    expect(controller.createBackgroundAudio(body, request)).toBe(
      'createBackgroundAudio',
    );
    expect(service.createBackgroundAudio).toHaveBeenCalledWith(
      body,
      authorization,
    );

    expect(controller.removeStandaloneAsset('a', request)).toBe(
      'removeStandaloneAsset',
    );
    expect(service.removeStandaloneAsset).toHaveBeenCalledWith(
      'a',
      authorization,
    );

    expect(
      controller.replaceAssetLabels('a', { labelIds: ['l'] }, request),
    ).toBe('replaceAssetLabels');
    expect(service.replaceAssetLabels).toHaveBeenCalledWith(
      'a',
      ['l'],
      authorization,
    );
  });

  it('delegates label operations with the request authorization', () => {
    const { controller, service } = build();
    expect(controller.resolveLabelImages('l')).toBe('resolveLabelImages');
    expect(service.resolveLabelImages).toHaveBeenCalledWith('l');

    expect(controller.findLabel('l', request)).toBe('findLabel');
    expect(service.findLabel).toHaveBeenCalledWith('l', authorization);

    const body = { name: 'n', description: 'd' };
    expect(controller.createLabel(body, request)).toBe('createLabel');
    expect(service.createLabel).toHaveBeenCalledWith(body, authorization);

    expect(controller.updateLabel('l', body, request)).toBe('updateLabel');
    expect(service.updateLabel).toHaveBeenCalledWith('l', body, authorization);

    expect(
      controller.replaceLabelAssets('l', { assetIds: ['a'] }, request),
    ).toBe('replaceLabelAssets');
    expect(service.replaceLabelAssets).toHaveBeenCalledWith(
      'l',
      ['a'],
      authorization,
    );

    expect(controller.removeLabel('l', request)).toBe('removeLabel');
    expect(service.removeLabel).toHaveBeenCalledWith('l', authorization);
  });

  it('requires access and keeps only label image resolution public', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, MediaAssetsController),
    ).toBe(ALCANTARA_PERMISSIONS.access);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        MediaAssetsController.prototype.resolveLabelImages,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        MediaAssetsController.prototype.findLabel,
      ),
    ).toBeUndefined();
  });

  it('records Object as the paramtype when MediaAssetsService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./media-assets.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media-assets.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaAssetsController),
      ).toEqual([Object]);
    });
    jest.dontMock('./media-assets.service');
  });
});

describe('MediaAssetsModule (coverage)', () => {
  const metrics = {
    recordJob: jest.fn(),
    recordMediaLabelAssignment: jest.fn(),
  };

  @Global()
  @Module({
    providers: [{ provide: ManagedMetricsService, useValue: metrics }],
    exports: [ManagedMetricsService],
  })
  class FakeObservabilityModule {}

  it('wires the controller, service and reconciliation provider', async () => {
    const prisma = {
      mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [FakeObservabilityModule, MediaAssetsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(MediaAssetsController)).toBeInstanceOf(
      MediaAssetsController,
    );
    expect(moduleRef.get(MediaAssetsReconciliationService)).toBeInstanceOf(
      MediaAssetsReconciliationService,
    );
    await expect(
      moduleRef.get(MediaAssetsService).findOne('x', { permissions: ['*'] }),
    ).rejects.toThrow('Media asset not found');
    expect(prisma.mediaAsset.findFirst).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
