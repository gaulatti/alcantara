import type { MultipartFile } from '@fastify/multipart';
import { BadRequestException, Controller, Post, Req } from '@nestjs/common';
import { UploadsService } from './uploads.service';

type MultipartRequest = {
  file: () => Promise<MultipartFile | undefined>;
};

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('instant')
  async uploadInstant(@Req() req: any) {
    const file = await this.readSingleFile(req);
    return this.uploadsService.upload({
      kind: 'instant',
      ...file,
    });
  }

  @Post('artwork')
  async uploadArtwork(@Req() req: any) {
    const file = await this.readSingleFile(req);
    return this.uploadsService.upload({
      kind: 'artwork',
      ...file,
    });
  }

  @Post('song')
  async uploadSong(@Req() req: any) {
    const file = await this.readSingleFile(req);
    return this.uploadsService.upload({
      kind: 'song',
      ...file,
    });
  }

  private async readSingleFile(req: any): Promise<{
    buffer: Buffer;
    mimeType: string;
    originalFilename: string;
  }> {
    const multipartReq = req as MultipartRequest;
    if (typeof multipartReq.file !== 'function') {
      throw new BadRequestException('Multipart uploads are not enabled');
    }

    const file = await multipartReq.file();
    if (!file) {
      throw new BadRequestException('file is required');
    }

    const buffer = await file.toBuffer();
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    return {
      buffer,
      mimeType: file.mimetype || '',
      originalFilename: file.filename || 'upload',
    };
  }
}
