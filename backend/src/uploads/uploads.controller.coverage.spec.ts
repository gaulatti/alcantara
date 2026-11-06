import { BadRequestException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UploadsController } from './uploads.controller';
import { UploadsModule } from './uploads.module';
import { UploadsService } from './uploads.service';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
}));
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

function build() {
  const uploads = { upload: jest.fn().mockResolvedValue({ key: 'k' }) };
  return { controller: new UploadsController(uploads as never), uploads };
}

function reqWith(file: unknown) {
  return { file: jest.fn().mockResolvedValue(file) };
}

describe('UploadsController (coverage)', () => {
  it.each([
    ['uploadInstant', 'instant'],
    ['uploadBackground', 'background'],
    ['uploadArtwork', 'artwork'],
    ['uploadSong', 'song'],
    ['uploadStinger', 'stinger'],
  ] as const)('%s uploads with kind %s', async (method, kind) => {
    const { controller, uploads } = build();
    const buffer = Buffer.from('x');
    const req = reqWith({
      toBuffer: jest.fn().mockResolvedValue(buffer),
      mimetype: 'audio/mpeg',
      filename: 'a.mp3',
    });

    await expect(controller[method](req)).resolves.toEqual({ key: 'k' });
    expect(uploads.upload).toHaveBeenCalledWith({
      kind,
      buffer,
      mimeType: 'audio/mpeg',
      originalFilename: 'a.mp3',
    });
  });

  it('defaults missing mime type and filename', async () => {
    const { controller, uploads } = build();
    const buffer = Buffer.from('x');
    await controller.uploadSong(
      reqWith({
        toBuffer: jest.fn().mockResolvedValue(buffer),
        mimetype: '',
        filename: '',
      }),
    );
    expect(uploads.upload).toHaveBeenCalledWith({
      kind: 'song',
      buffer,
      mimeType: '',
      originalFilename: 'upload',
    });
  });

  it('rejects requests without multipart support', async () => {
    const { controller, uploads } = build();
    await expect(controller.uploadInstant({})).rejects.toThrow(
      new BadRequestException('Multipart uploads are not enabled'),
    );
    expect(uploads.upload).not.toHaveBeenCalled();
  });

  it('rejects requests with no file part', async () => {
    const { controller } = build();
    await expect(controller.uploadInstant(reqWith(undefined))).rejects.toThrow(
      new BadRequestException('file is required'),
    );
  });

  it('rejects empty files', async () => {
    const { controller } = build();
    await expect(
      controller.uploadInstant(
        reqWith({ toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)) }),
      ),
    ).rejects.toThrow(new BadRequestException('Uploaded file is empty'));
  });
});

describe('UploadsController metadata (coverage)', () => {
  it('records Object as the paramtype when the service import is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./uploads.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./uploads.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.UploadsController),
      ).toEqual([Object]);
    });
    jest.dontMock('./uploads.service');
  });
});

describe('UploadsModule (coverage)', () => {
  it('wires the controller to the real service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        UploadsModule,
      ],
    }).compile();

    expect(moduleRef.get(UploadsController)).toBeInstanceOf(UploadsController);
    expect(moduleRef.get(UploadsService)).toBeInstanceOf(UploadsService);
    expect(
      (
        moduleRef.get(UploadsController) as unknown as {
          uploadsService: unknown;
        }
      ).uploadsService,
    ).toBe(moduleRef.get(UploadsService));
    await moduleRef.close();
  });
});
