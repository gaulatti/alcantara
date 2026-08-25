import { BadRequestException } from '@nestjs/common';
import { SongsService } from './songs.service';

function buildService() {
  const tx = {
    song: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    programState: { findUnique: jest.fn() },
    instant: { findUnique: jest.fn() },
    songIntro: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return { service: new SongsService(prisma as never), prisma, tx };
}

const song = {
  id: 7,
  artist: 'Artist',
  title: 'Song',
  audioUrl: 'https://media.test/song.mp3',
  coverUrl: null,
  durationMs: 120000,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
};

describe('SongsService song intros', () => {
  it('assigns and hydrates an authoritative Instant without copying media fields', async () => {
    const { service, tx } = buildService();
    tx.song.findUnique.mockResolvedValue(song);
    tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
    tx.songIntro.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    tx.instant.findUnique.mockResolvedValue({
      id: 12,
      enabled: true,
      audioUrl: 'https://media.test/intro.mp3',
    });
    tx.song.findUniqueOrThrow.mockResolvedValue({
      ...song,
      intro: {
        id: 3,
        songId: song.id,
        instantId: 12,
        programId: 'radio',
        instant: {
          id: 12,
          name: 'Voice segue',
          audioUrl: 'https://media.test/intro.mp3',
          volume: 0.7,
        },
      },
    });

    const result = await service.update(song.id, {
      programId: 'radio',
      introInstantId: 12,
    });

    expect(tx.songIntro.upsert).toHaveBeenCalledWith({
      where: { songId: song.id },
      create: { songId: song.id, instantId: 12, programId: 'radio' },
      update: { instantId: 12 },
    });
    expect(result.intro?.instant).toMatchObject({
      audioUrl: 'https://media.test/intro.mp3',
      volume: 0.7,
    });
  });

  it('removes an existing intro only from its owning program', async () => {
    const { service, tx } = buildService();
    tx.song.findUnique.mockResolvedValue(song);
    tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
    tx.songIntro.findUnique.mockResolvedValue({
      id: 3,
      programId: 'radio',
      instantId: 12,
    });
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...song, intro: null });

    await service.update(song.id, {
      programId: 'radio',
      introInstantId: null,
    });

    expect(tx.songIntro.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });

  it('rejects cross-program replacement and already-assigned Instants', async () => {
    const crossProgram = buildService();
    crossProgram.tx.song.findUnique.mockResolvedValue(song);
    crossProgram.tx.programState.findUnique.mockResolvedValue({
      programId: 'television',
    });
    crossProgram.tx.songIntro.findUnique.mockResolvedValue({
      id: 3,
      programId: 'radio',
      instantId: 12,
    });
    await expect(
      crossProgram.service.update(song.id, {
        programId: 'television',
        introInstantId: 13,
      }),
    ).rejects.toThrow('Song intro belongs to another program');

    const assigned = buildService();
    assigned.tx.song.findUnique.mockResolvedValue(song);
    assigned.tx.programState.findUnique.mockResolvedValue({
      programId: 'radio',
    });
    assigned.tx.songIntro.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ songId: 99, programId: 'radio' });
    assigned.tx.instant.findUnique.mockResolvedValue({
      id: 13,
      enabled: true,
      audioUrl: 'https://media.test/other.mp3',
    });
    await expect(
      assigned.service.update(song.id, {
        programId: 'radio',
        introInstantId: 13,
      }),
    ).rejects.toThrow('Instant is already assigned as a song intro');
  });

  it('rejects missing, disabled, and malformed intro identities', async () => {
    for (const [name, instantId, instant] of [
      ['malformed', -1, null],
      ['missing', 12, null],
      ['disabled', 12, { id: 12, enabled: false, audioUrl: 'url' }],
    ] as const) {
      const { service, tx } = buildService();
      tx.song.findUnique.mockResolvedValue(song);
      tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
      tx.songIntro.findUnique.mockResolvedValue(null);
      tx.instant.findUnique.mockResolvedValue(instant);
      await expect(
        service.update(song.id, {
          programId: 'radio',
          introInstantId: instantId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.songIntro.upsert).not.toHaveBeenCalled();
      expect(name).toBeTruthy();
    }
  });
});
