import { stateOf } from './capabilities.testing';
import {
  listPrograms,
  loadProgramLive,
  programIdsWhere,
  programsAffected,
  reasonsOf,
  whyNot,
} from './on-air';

function programs(
  state: Record<string, unknown>,
  song = false,
  instant: { isPlaying: boolean; sceneId: number | null } = {
    isPlaying: false,
    sceneId: null,
  },
) {
  return {
    getState: jest.fn().mockResolvedValue(stateOf(state)),
    getProgramSongPlayback: jest.fn().mockResolvedValue({ isPlaying: song }),
    getProgramSceneInstantPlayback: jest.fn().mockResolvedValue(instant),
    listPrograms: jest.fn().mockResolvedValue([stateOf(state)]),
  };
}

describe('loadProgramLive', () => {
  it('reports an idle program as idle, with its names and a stamp that names the live parts', async () => {
    const live = await loadProgramLive(programs({}) as never, 'main');
    expect(live).toMatchObject({
      programId: 'main',
      type: 'tv',
      visuallyOnAir: false,
      instantSceneId: null,
      reasons: [],
      liveText: 'nothing is live',
      queued: 0,
      stamp: 'scene:null fade:0 song:0 queue:0',
      scenes: [{ id: 3, name: 'Evening news' }],
      mediaGroups: [{ id: 5, name: 'Headlines' }],
      stingers: [{ id: 7, name: 'Whoosh' }],
      flightSequences: 0,
    });
  });

  it('lists every reason a program is live, in words', async () => {
    const live = await loadProgramLive(
      programs(
        {
          activeSceneId: 3,
          fadeToBlack: true,
          songQueue: [{ id: 'e1' }, { id: 'e2' }],
          activeFlightSequenceId: 9,
          flightSequences: [{}],
        },
        true,
        { isPlaying: true, sceneId: 3 },
      ) as never,
      'main',
    );
    expect(live.reasons).toEqual([
      'scene 3 is on air',
      'fade to black is on',
      'a song is playing',
      '2 song(s) are queued',
      'a flight sequence is active',
      'a scene instant is playing',
    ]);
    expect(live.liveText).toBe(live.reasons.join('; '));
    expect(live.visuallyOnAir).toBe(true);
    expect(live.instantSceneId).toBe(3);
    expect(live.flightSequences).toBe(1);
    expect(live.stamp).toBe('scene:3 fade:1 song:1 queue:2');
  });

  it('counts no queue when the stored queue is not a list', async () => {
    const live = await loadProgramLive(
      programs({ songQueue: null }) as never,
      'main',
    );
    expect(live.queued).toBe(0);
  });
});

describe('usage helpers', () => {
  it('whyNot joins the conditions that hold, or answers null', () => {
    expect(
      whyNot([
        [false, 'a'],
        [true, 'b'],
        [true, 'c'],
      ]),
    ).toBe('b; c');
    expect(whyNot([[false, 'a']])).toBeNull();
    expect(reasonsOf([[true, 'x']])).toEqual(['x']);
  });

  it('finds the programs a test holds for and names them for a dry run', async () => {
    const listed = await listPrograms(programs({ activeSceneId: 3 }) as never);
    expect(programIdsWhere(listed, (p) => p.activeSceneId === 3)).toEqual([
      'main',
    ]);
    expect(programsAffected(['main'])).toEqual([
      { kind: 'program', id: 'main', name: 'main' },
    ]);
  });
});
