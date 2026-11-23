/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- tool answers are untyped JSON. */
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { principalWith, specNamed } from './capabilities.testing';
import { SongLeavesMcpTools } from './song-leaves';

// gaulatti/alcantara#327: the capability adds its row, its argument limits, its plan (the dry run
// of the confirm flow) and the program id to the service's answer. The removal itself is pinned in
// the engine and service specs.

const ctx = { principal: principalWith(ALCANTARA_PERMISSIONS.program.operate) };
const programs = {
  getState: jest.fn(),
  getProgramSongPlayback: jest.fn(),
  getProgramSceneInstantPlayback: jest.fn(),
  removeProgramSongLeaves: jest.fn(),
};
const spec = specNamed(
  new SongLeavesMcpTools(programs as never).specs(),
  'program_remove_program_song_leaves_by_id',
);
const schema = z.object(spec.shape as z.ZodRawShape);

beforeEach(() => {
  jest.resetAllMocks();
  programs.getState.mockResolvedValue({
    programId: 'radio-1',
    type: 'radio',
    activeSceneId: null,
    stagedSceneId: null,
    activeFlightSequenceId: null,
    fadeToBlack: false,
    songQueue: [],
    scenes: [],
    mediaGroups: [],
    stingers: [],
    flightSequences: [],
  });
  programs.getProgramSongPlayback.mockResolvedValue({ isPlaying: true });
  programs.getProgramSceneInstantPlayback.mockResolvedValue({
    isPlaying: false,
  });
});

describe('program_remove_program_song_leaves_by_id (#327)', () => {
  it('is an A row on program.operate', () => {
    expect(spec.tier).toBe('A');
    expect(spec.permission).toBe(ALCANTARA_PERMISSIONS.program.operate);
  });

  it('takes 1 to 200 leaf ids and refuses none, too many, or an empty id', () => {
    const ok = (leaf_ids: string[]) =>
      schema.safeParse({ program_id: 'radio-1', leaf_ids }).success;
    expect(ok([])).toBe(false);
    expect(ok([''])).toBe(false);
    expect(ok(['a'])).toBe(true);
    expect(ok(Array.from({ length: 200 }, (_, i) => `id${i}`))).toBe(true);
    expect(ok(Array.from({ length: 201 }, (_, i) => `id${i}`))).toBe(false);
  });

  it('plans the removal, or the listing for a dry run, naming the live state', async () => {
    const removal = await spec.dryRun!(
      { program_id: 'radio-1', leaf_ids: ['a', 'b'], keep_rotation: true },
      ctx,
    );
    expect(removal.summary).toContain('Removes 2 leaf(s)');
    expect(removal.summary).toContain('moved on if the leaf on air');
    expect(removal.summary).toContain('a song is playing');
    expect(removal.affects).toEqual([
      { kind: 'program', id: 'radio-1', name: 'radio-1' },
    ]);
    expect(removal.recoverable).toBe(false);

    const dry = await spec.dryRun!(
      { program_id: 'radio-1', leaf_ids: ['a'], dry_run: true },
      ctx,
    );
    expect(dry.summary).toContain('nothing is written');

    const plain = await spec.dryRun!(
      { program_id: 'radio-1', leaf_ids: ['a'] },
      ctx,
    );
    expect(plain.summary).not.toContain('moved on');
  });

  it('names the program and its live stamp for the confirm', async () => {
    const target = await spec.confirmTarget!(
      { program_id: 'radio-1', leaf_ids: ['a'] },
      ctx,
    );
    expect(target.id).toBe('radio-1');
    expect(target.name).toContain('song:1');
  });

  it('calls the service with the arguments and adds the program id to its answer', async () => {
    programs.removeProgramSongLeaves.mockResolvedValue({
      dryRun: true,
      removed: [],
      leafCountBefore: 3,
      leafCountAfter: 3,
      cursorMovedTo: null,
      version: null,
    });
    const outcome = await spec.run(
      {
        program_id: 'radio-1',
        leaf_ids: ['a'],
        keep_rotation: false,
        dry_run: true,
      },
      ctx,
    );
    expect(programs.removeProgramSongLeaves).toHaveBeenCalledWith(
      'radio-1',
      ['a'],
      { keepRotation: false, dryRun: true },
    );
    expect(outcome.audit).toEqual({ target: 'radio-1' });
    expect(JSON.stringify(outcome.result)).toContain('"program_id":"radio-1"');
    expect(JSON.stringify(outcome.result)).toContain('"leafCountBefore":3');
  });
});

describe('SongLeavesMcpTools decorator metadata under an unresolved circular import', () => {
  it('records Object for a ProgramService that is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../program/program.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SongLeavesMcpTools: Isolated } = require('./song-leaves');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });
});
