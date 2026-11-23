import { ScenesService } from './scenes.service';

describe('ScenesService neutral bracket entry points', () => {
  it('hands each call, unchanged, to the bracket method of the same verb', async () => {
    const service = new ScenesService({} as never, {} as never);
    const draw = jest
      .spyOn(service, 'drawModoItalianoBracket')
      .mockResolvedValue({ drawId: 1 } as never);
    const vote = jest
      .spyOn(service, 'voteModoItalianoBracket')
      .mockResolvedValue({ id: 2 } as never);
    const open = jest
      .spyOn(service, 'openModoItalianoBracketVoting')
      .mockResolvedValue({ id: 3 } as never);

    await expect(service.drawBracket(3, { seed: 7 })).resolves.toEqual({
      drawId: 1,
    });
    await expect(
      service.voteBracket(3, { matchId: 1, voterId: 'v', songId: null }),
    ).resolves.toEqual({ id: 2 });
    await expect(service.openBracketVoting(3, { matchId: 2 })).resolves.toEqual(
      { id: 3 },
    );
    expect(draw).toHaveBeenCalledWith(3, { seed: 7 });
    expect(vote).toHaveBeenCalledWith(3, {
      matchId: 1,
      voterId: 'v',
      songId: null,
    });
    expect(open).toHaveBeenCalledWith(3, { matchId: 2 });
  });
});
