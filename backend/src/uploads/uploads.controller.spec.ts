import { BadRequestException } from '@nestjs/common';
import { UploadsController } from './uploads.controller';

jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

describe('UploadsController multipart boundary', () => {
  it.each([
    ['uploadInstant', 'instant'],
    ['uploadBackground', 'background'],
    ['uploadArtwork', 'artwork'],
    ['uploadSong', 'song'],
    ['uploadStinger', 'stinger'],
  ] as const)(
    'passes %s bytes and file metadata into the correct upload family',
    async (method, kind) => {
      const result = { key: 'stored-file' };
      const uploads = { upload: jest.fn().mockResolvedValue(result) };
      const buffer = Buffer.from('fictional upload');
      const controller = new UploadsController(uploads as any);
      expect(
        await controller[method]({
          file: async () => ({
            filename: 'file.mp3',
            mimetype: 'audio/mpeg',
            toBuffer: async () => buffer,
          }),
        }),
      ).toBe(result);
      expect(uploads.upload).toHaveBeenCalledWith({
        kind,
        buffer,
        mimeType: 'audio/mpeg',
        originalFilename: 'file.mp3',
      });
    },
  );

  it('uses the documented filename/MIME defaults when the multipart adapter omits metadata', async () => {
    const uploads = { upload: jest.fn() };
    const buffer = Buffer.from('bytes');
    await new UploadsController(uploads as any).uploadInstant({
      file: async () => ({ toBuffer: async () => buffer }),
    });
    expect(uploads.upload).toHaveBeenCalledWith({
      kind: 'instant',
      buffer,
      mimeType: '',
      originalFilename: 'upload',
    });
  });

  it.each([
    [{}, 'Multipart uploads are not enabled'],
    [{ file: async () => undefined }, 'file is required'],
    [
      { file: async () => ({ toBuffer: async () => Buffer.alloc(0) }) },
      'Uploaded file is empty',
    ],
  ])(
    'rejects missing/empty multipart input without requesting storage',
    async (request, message) => {
      const uploads = { upload: jest.fn() };
      const controller = new UploadsController(uploads as any);
      await expect(controller.uploadSong(request)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(controller.uploadSong(request)).rejects.toThrow(message);
      expect(uploads.upload).not.toHaveBeenCalled();
    },
  );
});
