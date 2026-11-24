import { SongExecutionEngine } from './song-execution.engine';

// gaulatti/alcantara#242: the program bus overlap check asks whether an instant is one of the engine's bumper
// spots; the answer is a read of the engine's own sent spots and changes nothing.

describe('SongExecutionEngine.isBumperSpot', () => {
  it('answers from the sent spots of the program, without changing them', () => {
    const engine = Object.create(
      SongExecutionEngine.prototype,
    ) as SongExecutionEngine;
    const sent = new Map([
      ['spot-1', { name: 'Fictional spot', path: 'announced' }],
    ]);
    (engine as unknown as { states: Map<string, unknown> }).states = new Map<
      string,
      unknown
    >([
      ['fixture.fm', { bumperSpotsSent: sent }],
      ['no-spots.fm', {}],
    ]);
    expect(engine.isBumperSpot('fixture.fm', 'spot-1')).toBe(true);
    expect(engine.isBumperSpot('fixture.fm', 'cartwall-1')).toBe(false);
    expect(engine.isBumperSpot('no-spots.fm', 'spot-1')).toBe(false);
    expect(engine.isBumperSpot('unknown.fm', 'spot-1')).toBe(false);
    expect([...sent.keys()]).toEqual(['spot-1']);
  });
});
