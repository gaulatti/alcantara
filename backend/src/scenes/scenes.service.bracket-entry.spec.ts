import { BadRequestException } from '@nestjs/common';
import { ScenesService } from './scenes.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// A bracket is the scene's own: its layout element or its state key. No brand's key is assumed when the scene names none.
describe('ScenesService bracket resolution', () => {
  const sceneWith = (metadata: Record<string, unknown>, componentType = 'slideshow') => ({
    id: 3,
    metadata: JSON.stringify(metadata),
    layout: { componentType },
  });
  const serviceFor = (scene: unknown) => {
    const service = new ScenesService({} as never, {} as never, noRecorder());
    jest.spyOn(service, 'findOne').mockResolvedValue(scene as never);
    return service;
  };

  it('refuses every bracket action on a scene that has no bracket, writing nothing', async () => {
    const service = serviceFor(sceneWith({ slideshow: { images: [] } }));
    const persist = jest.spyOn(service as never, 'persistSceneMetadata');
    const refusal = new BadRequestException('This scene has no bracket');
    await expect(service.drawBracket(3, {})).rejects.toThrow(refusal);
    await expect(
      service.voteBracket(3, { matchId: 1, voterId: 'v', songId: null }),
    ).rejects.toThrow(refusal);
    await expect(service.openBracketVoting(3, { matchId: 2 })).rejects.toThrow(
      refusal,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("acts on the bracket the scene's state names, whatever its name", async () => {
    const bracket = {
      matches: Array.from({ length: 15 }, (_, index) => ({
        id: index + 1,
        songAId: index === 1 ? 10 : null,
        songBId: index === 1 ? 11 : null,
        winnerId: null,
      })),
    };
    const service = serviceFor(sceneWith({ 'harbor-light-bracket': bracket }));
    const persist = jest
      .spyOn(service as never, 'persistSceneMetadata')
      .mockResolvedValue({ id: 3 } as never);
    await service.openBracketVoting(3, { matchId: 2 });
    expect(persist).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        'harbor-light-bracket': expect.objectContaining({ activeVotingMatchId: 2 }),
      }),
      0,
    );
  });

  it('refuses a vote on a requested bracket the scene does not hold: it has no voters', async () => {
    const service = serviceFor(sceneWith({ slideshow: {} }));
    await expect(
      service.voteBracket(3, {
        componentType: 'missing-bracket',
        matchId: 1,
        voterId: 'v',
        songId: null,
      }),
    ).rejects.toThrow('Unknown voter');
  });
});

