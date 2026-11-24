import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { ProgramService } from './program.service';

// gaulatti/alcantara#235: which programs have a song on air, for the re-analysis guard.
type View = {
  songId: number | null;
  nextSongId: number | null;
  next: { status: string } | null;
};
const idle: View = { songId: null, nextSongId: null, next: null };

function build(
  programs: Record<
    string,
    { playback: { isPlaying: boolean; audioUrl: string }; view: View }
  >,
) {
  const prisma = {
    programState: {
      findMany: jest.fn(async () =>
        Object.keys(programs).map((programId) => ({ programId })),
      ),
    },
  };
  const engine = {
    getOnAirView: jest.fn((programId: string) => programs[programId].view),
  };
  const service = new ProgramService(
    prisma as never,
    {} as never,
    engine as never,
    undefined,
    undefined,
    noRecorder(),
  );
  jest
    .spyOn(service, 'getProgramSongPlayback')
    .mockImplementation(
      async (programId?: string) => programs[programId!].playback as never,
    );
  return { service, prisma, engine };
}

const song = (id: number) => ({ id, audioUrl: `https://media.test/${id}.mp3` });
const quiet = { isPlaying: false, audioUrl: '' };

describe('ProgramService.programsHoldingSongs', () => {
  it('lists every song, empty when no program has it on air', async () => {
    const { service, prisma } = build({
      radio: { playback: quiet, view: idle },
    });
    await expect(
      service.programsHoldingSongs([song(1), song(2)]),
    ).resolves.toEqual(
      new Map([
        [1, []],
        [2, []],
      ]),
    );
    expect(prisma.programState.findMany).toHaveBeenCalledWith({
      select: { programId: true },
    });
  });

  it('finds a song the engine says is playing, and one whose audio the program is playing', async () => {
    const { service } = build({
      radio: { playback: quiet, view: { ...idle, songId: 1 } },
      tv: {
        playback: { isPlaying: true, audioUrl: ' https://media.test/2.mp3 ' },
        view: idle,
      },
    });
    await expect(
      service.programsHoldingSongs([song(1), song(2), song(3)]),
    ).resolves.toEqual(
      new Map([
        [1, ['radio']],
        [2, ['tv']],
        [3, []],
      ]),
    );
  });

  it('does not count audio that is paused or another song, and trims the address it compares', async () => {
    const { service } = build({
      radio: {
        playback: { isPlaying: false, audioUrl: 'https://media.test/1.mp3' },
        view: idle,
      },
      tv: {
        playback: { isPlaying: true, audioUrl: 'https://media.test/9.mp3' },
        view: idle,
      },
    });
    await expect(
      service.programsHoldingSongs([
        { id: 1, audioUrl: ' https://media.test/1.mp3' },
      ]),
    ).resolves.toEqual(new Map([[1, []]]));
  });

  it('finds the announced next song unless Palazzo refused the announcement', async () => {
    const { service } = build({
      a: {
        playback: quiet,
        view: { ...idle, nextSongId: 1, next: { status: 'accepted' } },
      },
      b: {
        playback: quiet,
        view: { ...idle, nextSongId: 1, next: { status: 'pending' } },
      },
      c: {
        playback: quiet,
        view: { ...idle, nextSongId: 1, next: { status: 'not-announced' } },
      },
      d: { playback: quiet, view: { ...idle, nextSongId: 2, next: null } },
    });
    await expect(
      service.programsHoldingSongs([song(1), song(2)]),
    ).resolves.toEqual(
      new Map([
        [1, ['a', 'b']],
        [2, []],
      ]),
    );
  });

  it('lists a program once per song even when it both plays and announces it', async () => {
    const { service } = build({
      radio: {
        playback: quiet,
        view: { songId: 1, nextSongId: 1, next: { status: 'accepted' } },
      },
    });
    await expect(service.programsHoldingSongs([song(1)])).resolves.toEqual(
      new Map([[1, ['radio']]]),
    );
  });
});
