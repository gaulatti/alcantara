import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseBuffer } from 'music-metadata';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

type UploadKind = 'instant' | 'artwork' | 'song';

interface UploadPayload {
  kind: UploadKind;
  buffer: Buffer;
  mimeType: string;
  originalFilename: string;
}

export interface UploadResult {
  key: string;
  url: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  metadata?: {
    artist?: string;
    title?: string;
    durationMs?: number;
    coverUrl?: string;
  };
}

const MAX_INSTANT_BYTES = 100 * 1024 * 1024;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const MAX_SONG_BYTES = 100 * 1024 * 1024;

const INSTANT_MIME_TYPES = new Set<string>([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-aac',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
]);

const INSTANT_EXTENSIONS = new Set<string>([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.oga',
  '.ogg',
  '.wav',
  '.weba',
  '.webm',
]);

const ARTWORK_MIME_TYPES = new Set<string>([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const ARTWORK_EXTENSIONS = new Set<string>([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);

@Injectable()
export class UploadsService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = (
      this.configService.get<string>('MEDIA_S3_BUCKET') ?? ''
    ).trim();
    this.region =
      (
        this.configService.get<string>('AWS_REGION') ??
        this.configService.get<string>('AWS_DEFAULT_REGION') ??
        'us-east-1'
      ).trim() || 'us-east-1';

    this.s3 = new S3Client({
      region: this.region,
    });
  }

  async upload(payload: UploadPayload): Promise<UploadResult> {
    this.assertConfigured();
    this.validateUpload(payload);

    const extension =
      this.normalizeExtension(extname(payload.originalFilename)) ||
      this.defaultExtensionForKind(payload.kind);
    const contentType = this.normalizeMimeType(payload.mimeType)
      ? payload.mimeType.trim().toLowerCase()
      : this.defaultContentTypeForKind(payload.kind);
    const key = this.buildObjectKey(
      payload.kind,
      payload.originalFilename,
      extension,
    );

    try {
      await this.uploadObjectToS3(key, payload.buffer, contentType);
    } catch (error) {
      console.error('Failed to upload object to S3', error);
      throw new InternalServerErrorException('Failed to upload file to S3');
    }

    const metadata =
      payload.kind === 'song'
        ? await this.extractAndUploadSongMetadata(payload)
        : undefined;

    return {
      key,
      url: this.buildPublicUrl(key),
      bucket: this.bucket,
      contentType,
      sizeBytes: payload.buffer.length,
      metadata,
    };
  }

  private assertConfigured() {
    if (!this.bucket) {
      throw new InternalServerErrorException(
        'MEDIA_S3_BUCKET is not configured',
      );
    }
  }

  private validateUpload(payload: UploadPayload) {
    if (!payload.buffer.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    const mimeType = this.normalizeMimeType(payload.mimeType);
    const extension = this.normalizeExtension(
      extname(payload.originalFilename),
    );
    const isAudioUpload = payload.kind === 'instant' || payload.kind === 'song';
    const { maxBytes, allowedMimeTypes, allowedExtensions, fileTypeLabel } =
      isAudioUpload
        ? {
            maxBytes:
              payload.kind === 'song' ? MAX_SONG_BYTES : MAX_INSTANT_BYTES,
            allowedMimeTypes: INSTANT_MIME_TYPES,
            allowedExtensions: INSTANT_EXTENSIONS,
            fileTypeLabel: 'audio',
          }
        : {
            maxBytes: MAX_ARTWORK_BYTES,
            allowedMimeTypes: ARTWORK_MIME_TYPES,
            allowedExtensions: ARTWORK_EXTENSIONS,
            fileTypeLabel: 'image',
          };

    if (payload.buffer.length > maxBytes) {
      throw new BadRequestException(
        `File too large. Max size is ${Math.floor(maxBytes / (1024 * 1024))}MB`,
      );
    }

    const isMimeAllowed = !!mimeType && allowedMimeTypes.has(mimeType);
    const isExtensionAllowed = !!extension && allowedExtensions.has(extension);

    if (!isMimeAllowed && !isExtensionAllowed) {
      throw new BadRequestException(`Unsupported ${fileTypeLabel} file type`);
    }
  }

  private buildObjectKey(
    kind: UploadKind,
    originalFilename: string,
    extension: string,
  ): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const baseName = this.sanitizeBaseName(originalFilename);
    const suffix = randomUUID();
    const fileName = `${baseName}-${suffix}${extension}`;

    const parts = [kind, `${yyyy}/${mm}/${dd}`, fileName];
    return parts.join('/');
  }

  private buildPublicUrl(key: string): string {
    const encodedKey = key
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');

    if (this.region === 'us-east-1') {
      return `https://${this.bucket}.s3.amazonaws.com/${encodedKey}`;
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`;
  }

  private sanitizeBaseName(filename: string): string {
    const withoutExtension = filename.replace(/\.[^/.]+$/, '');
    const sanitized = withoutExtension
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 48);

    return sanitized || 'asset';
  }

  private normalizeMimeType(value: string): string {
    return value.trim().toLowerCase();
  }

  private normalizeExtension(value: string): string {
    return value.trim().toLowerCase();
  }

  private defaultExtensionForKind(kind: UploadKind): string {
    return kind === 'artwork' ? '.jpg' : '.mp3';
  }

  private defaultContentTypeForKind(kind: UploadKind): string {
    return kind === 'artwork' ? 'image/jpeg' : 'audio/mpeg';
  }

  private async uploadObjectToS3(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  private async extractAndUploadSongMetadata(payload: UploadPayload): Promise<{
    artist?: string;
    title?: string;
    durationMs?: number;
    coverUrl?: string;
  }> {
    const parsed = await this.parseSongMetadata(payload);
    if (!parsed) {
      return {};
    }

    let coverUrl: string | undefined;
    if (parsed.coverBuffer && parsed.coverMimeType) {
      const extension =
        this.extensionForImageMimeType(parsed.coverMimeType) || '.jpg';
      const coverKey = this.buildObjectKey(
        'artwork',
        `${payload.originalFilename}-cover`,
        extension,
      );
      try {
        await this.uploadObjectToS3(
          coverKey,
          parsed.coverBuffer,
          parsed.coverMimeType,
        );
        coverUrl = this.buildPublicUrl(coverKey);
      } catch (error) {
        console.error('Failed to upload extracted song cover to S3', error);
      }
    }

    return {
      artist: parsed.artist,
      title: parsed.title,
      durationMs: parsed.durationMs,
      coverUrl,
    };
  }

  private async parseSongMetadata(payload: UploadPayload): Promise<{
    artist?: string;
    title?: string;
    durationMs?: number;
    coverBuffer?: Buffer;
    coverMimeType?: string;
  } | null> {
    try {
      const metadata = await parseBuffer(
        payload.buffer,
        payload.mimeType || '',
        {
          duration: true,
        },
      );

      const artist =
        typeof metadata.common.artist === 'string' &&
        metadata.common.artist.trim()
          ? metadata.common.artist.trim()
          : Array.isArray(metadata.common.artists) &&
              metadata.common.artists.length > 0
            ? metadata.common.artists[0]?.trim() || undefined
            : undefined;

      const title =
        typeof metadata.common.title === 'string' &&
        metadata.common.title.trim()
          ? metadata.common.title.trim()
          : undefined;

      const durationMs =
        typeof metadata.format.duration === 'number' &&
        Number.isFinite(metadata.format.duration) &&
        metadata.format.duration > 0
          ? Math.max(1, Math.round(metadata.format.duration * 1000))
          : undefined;

      const firstPicture =
        Array.isArray(metadata.common.picture) && metadata.common.picture.length
          ? metadata.common.picture[0]
          : undefined;
      const coverBuffer = firstPicture?.data
        ? Buffer.from(firstPicture.data)
        : undefined;
      const coverMimeType =
        typeof firstPicture?.format === 'string' && firstPicture.format.trim()
          ? firstPicture.format.trim().toLowerCase()
          : undefined;

      if (!artist && !title && !durationMs && !coverBuffer) {
        return null;
      }

      return {
        artist,
        title,
        durationMs,
        coverBuffer,
        coverMimeType,
      };
    } catch (error) {
      console.warn('Unable to extract song metadata from upload', error);
      return null;
    }
  }

  private extensionForImageMimeType(mimeType: string): string | null {
    switch (mimeType.trim().toLowerCase()) {
      case 'image/avif':
        return '.avif';
      case 'image/gif':
        return '.gif';
      case 'image/jpg':
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      default:
        return null;
    }
  }
}
