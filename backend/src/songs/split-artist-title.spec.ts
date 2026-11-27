import { splitArtistTitle } from './split-artist-title';
import { SongsService } from './songs.service';

describe('splitArtistTitle', () => {
  it('splits "Artist - Title" held whole as the artist of an untitled song', () => {
    expect(
      splitArtistTitle('Fictional One, Two - Song (Spanish Version)', ''),
    ).toEqual({
      artist: 'Fictional One, Two',
      title: 'Song (Spanish Version)',
    });
  });

  it.each([
    ['A - B', 'Given title'],
    ['No separator', ''],
    ['A - B - C', ''],
    ['Hi-nrg', ''],
    [' - B', ''],
    ['A - ', ''],
    ['', ''],
  ])('keeps artist %j and title %j as given', (artist, title) => {
    expect(splitArtistTitle(artist, title)).toEqual({ artist, title });
  });
});

// The console imports a file with no tags as its file name for artist and no title (the owner's "Title unavailable").
describe('SongsService create from an untagged file', () => {
  it('stores the file name as artist and title', async () => {
    const stored = new Error('stored');
    const create = jest.fn().mockRejectedValue(stored);
    const prisma = {
      $transaction: (run: (tx: unknown) => unknown) =>
        run({ song: { create } }),
    };
    const service = new SongsService(
      { forTeam: () => prisma, ...prisma } as never,
      {} as never,
    );
    jest
      .spyOn(service as unknown as { db: () => unknown }, 'db')
      .mockReturnValue(prisma);

    await expect(
      service.create(
        {
          artist: 'Fictional One - Fictional Song',
          title: '',
          audioUrl: 'https://media.test/a.mp3',
        },
        1,
      ),
    ).rejects.toThrow('stored');
    expect(create.mock.calls[0]).toMatchObject([
      { data: { artist: 'Fictional One', title: 'Fictional Song' } },
    ]);
  });
});
