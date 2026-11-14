import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { SongsService } from './songs.service';

describe('song creation intro and optional metadata boundaries', () => {
  function fixture() {
    const song = {
      id: 7,
      assetId: 'song:7',
      coverAssetId: null,
      artist: 'Artist',
      title: 'Song',
      audioUrl: 'https://media.invalid/song',
      coverUrl: null,
      enabled: true,
      intro: null,
    };
    let saved = { ...song };
    const tx = {
      song: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          saved = { ...song, ...data };
          return Promise.resolve(saved);
        }),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(saved)),
      },
      mediaAsset: {
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn(),
      },
      programState: {
        findUnique: jest.fn().mockResolvedValue({ programId: 'radio' }),
      },
      songIntro: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    return {
      service: new SongsService(prisma as unknown as PrismaService),
      tx,
    };
  }

  it('refuses intro assignment to a missing program instead of writing an orphan association', async () => {
    const { service, tx } = fixture();
    tx.programState.findUnique.mockResolvedValue(null);
    await expect(
      service.create({
        artist: 'Artist',
        audioUrl: 'https://media.invalid/song',
        introInstantId: 12,
        programId: 'missing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.songIntro.findUnique).not.toHaveBeenCalled();
    expect(tx.songIntro.upsert).not.toHaveBeenCalled();
  });

  it('treats explicit intro removal as a no-op when no assignment exists during creation', async () => {
    const { service, tx } = fixture();
    await expect(
      service.create({
        artist: 'Artist',
        audioUrl: 'https://media.invalid/song',
        introInstantId: null,
        programId: 'radio',
      }),
    ).resolves.toMatchObject({ intro: null });
    expect(tx.songIntro.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { songId: 7 } }),
    );
    expect(tx.songIntro.delete).not.toHaveBeenCalled();
    expect(tx.songIntro.upsert).not.toHaveBeenCalled();
  });

  it('normalizes blank optional cover metadata to null without creating an empty cover asset', async () => {
    const { service, tx } = fixture();
    await expect(
      service.create({
        artist: 'Artist',
        audioUrl: 'https://media.invalid/song',
        coverUrl: '   ',
      }),
    ).resolves.toMatchObject({ coverUrl: null });
    expect(tx.song.create.mock.calls[0][0].data.coverUrl).toBeNull();
    expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(1);
    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'song:7' } }),
    );
  });
});
