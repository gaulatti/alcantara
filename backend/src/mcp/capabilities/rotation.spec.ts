import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { McpToolError, type McpContext } from '../contract';
import {
  normalizeProgramSongSequence,
  shuffleProgramSongOrder,
} from '../../radio/song-sequence.utils';
import { RotationMcpTools } from './rotation';

// gaulatti/alcantara#788: the radio desk's rotation actions as MCP tools.

const song = (n: number) => ({
  id: `row-${n}`,
  kind: 'preset',
  songId: n,
  title: `Song ${n}`,
  artist: 'Artist',
  coverUrl: '',
  audioUrl: `https://example.test/${n}.mp3`,
  durationMs: 1000,
});
const ctx = {} as McpContext;

jest.mock('./on-air', () => ({
  loadProgramLive: jest.fn(async () => ({
    stamp: 'radio-1',
    liveText: 'nothing',
  })),
}));

const unlisted = {
  id: 'custom',
  kind: 'preset',
  title: 'No id',
  artist: '',
  coverUrl: '',
  highRotation: true,
};

function setup(sequence: Record<string, unknown> | null = {}, playing = false) {
  const stored =
    sequence === null
      ? null
      : {
          mode: 'manual',
          loop: true,
          items: [
            song(1),
            song(2),
            song(3),
            {
              id: 'block',
              kind: 'sequence',
              label: 'B',
              sequence: { items: [] },
            },
          ],
          activeItemId: 'row-2',
          startedAt: 1,
          note: 'kept',
          ...sequence,
        };
  const programs = {
    getProgramAudioBus: jest.fn(async () => ({
      songSequence: stored,
      sequenceVersion: 'v1',
    })),
    refuseOperatorStartWhileEngineUnavailable: jest.fn(),
    updateProgramAudioBus: jest.fn(async () => ({ sequenceVersion: 'v2' })),
  };
  const radio = { refuseStartWhileEngineUnavailable: jest.fn() };
  const engine = {
    getPlaybackState: jest.fn(() => (playing ? { isPlaying: true } : null)),
    handleManualSong: jest.fn(),
  };
  const songs = {
    findOne: jest.fn(async (id: number) => ({
      id,
      enabled: id !== 99,
      title: 'Added',
      artist: 'New',
      coverUrl: null,
      audioUrl: 'https://example.test/added.mp3',
      durationMs: id === 8 ? null : 2000,
    })),
  };
  const tools = new RotationMcpTools(
    programs as never,
    radio as never,
    engine as never,
    songs as never,
    { teamId: 7 } as never,
  ).specs();
  const tool = (name: string) => tools.find((spec) => spec.name === name)!;
  // Every write names the version it was read at; the stored rotation is at v1.
  const run = (name: string, args: Record<string, unknown>) =>
    tool(name).run(
      { program_id: 'radio-1', sequence_version: 'v1', ...args } as never,
      ctx,
    );
  const dry = (name: string, args: Record<string, unknown>) =>
    tool(name).dryRun!(
      { program_id: 'radio-1', sequence_version: 'v1', ...args } as never,
      ctx,
    );
  const saved = () =>
    programs.updateProgramAudioBus.mock.calls.at(-1) as unknown as [
      {
        songSequence: Record<string, unknown> & {
          items: Array<{ id: string }>;
        };
        sequenceVersion: string;
      },
      string,
      string,
    ];
  return { tools, tool, run, dry, saved, programs, radio, engine, songs };
}

describe('rotation capabilities', () => {
  it('reads the rotation with item ids, play order and when it ended', async () => {
    const { run } = setup(
      { mode: 'shuffle', shuffleOrder: ['row-3', 'row-1'], endedAt: 1000 },
      true,
    );
    const { result } = await run('radio_get_rotation', {});
    const text = JSON.stringify(result);
    expect(text).toContain('"mode":"shuffle"');
    expect(text).toContain('"playing":true');
    expect(text).toContain('"ended_at":"1970-01-01T00:00:01.000Z"');
    expect(text).toContain('"play_order":["row-3","row-1","row-2","block"]');
    expect(text).toContain('"block":true');
    expect(text).toContain('Song 1');
    await expect(
      setup({}).run('radio_get_rotation', {}),
    ).resolves.toBeDefined();
    await expect(setup(null).run('radio_get_rotation', {})).rejects.toThrow(
      McpToolError,
    );
  });

  it('marks a row with no library song, and a high rotation one', async () => {
    const { result } = await setup({ items: [unlisted, song(1)] }).run(
      'radio_get_rotation',
      {},
    );
    expect(JSON.stringify(result)).toContain(
      '"song_id":null,"high_rotation":true',
    );
  });

  it('shuffles as the desk does: a new order from the cursor, the rows untouched', async () => {
    const t = setup({ endedAt: 5 });
    await t.run('radio_set_rotation_mode', { mode: 'shuffle' });
    const [data, program, client] = t.saved();
    expect(program).toBe('radio-1');
    expect(client).toBe('mcp');
    expect(data.sequenceVersion).toBe('v1');
    expect(data.songSequence.items.map((item) => item.id)).toEqual([
      'row-1',
      'row-2',
      'row-3',
      'block',
    ]);
    const order = data.songSequence.shuffleOrder as string[];
    expect(order[0]).toBe('row-2');
    expect([...order].sort()).toEqual(['block', 'row-1', 'row-2', 'row-3']);
    expect(data.songSequence).toMatchObject({
      mode: 'shuffle',
      activeItemId: 'row-2',
      note: 'kept',
    });
    expect(data.songSequence).not.toHaveProperty('endedAt');
    expect(data.songSequence.startedAt).not.toBe(1);
    expect(
      t.programs.refuseOperatorStartWhileEngineUnavailable,
    ).toHaveBeenCalled();

    const on = setup({ activeItemId: null }, true);
    await on.run('radio_set_rotation_mode', { mode: 'shuffle' });
    expect(on.saved()[0].songSequence.startedAt).toBe(1);
    expect(on.saved()[0].songSequence.activeItemId).toBe(
      (on.saved()[0].songSequence.shuffleOrder as string[])[0],
    );
  });

  it('sets manual, autoplay and loop, giving autoplay a first song when there is no cursor', async () => {
    const auto = setup({ activeItemId: null });
    await auto.run('radio_set_rotation_mode', {
      mode: 'autoplay',
      loop: false,
    });
    expect(auto.saved()[0].songSequence).toMatchObject({
      mode: 'autoplay',
      loop: false,
      activeItemId: 'row-1',
    });
    const manual = setup({ activeItemId: null });
    await manual.run('radio_set_rotation_mode', { mode: 'manual' });
    expect(manual.saved()[0].songSequence).toMatchObject({
      mode: 'manual',
      activeItemId: null,
    });
    const loop = setup({ endedAt: 5 });
    await loop.run('radio_set_rotation_mode', { loop: false });
    expect(loop.saved()[0].songSequence).toMatchObject({
      loop: false,
      mode: 'manual',
      endedAt: 5,
      startedAt: 1,
    });
    const empty = setup({ activeItemId: null, items: [] });
    await empty.run('radio_set_rotation_mode', { mode: 'autoplay' });
    expect(empty.saved()[0].songSequence.activeItemId).toBeNull();
  });

  it('refuses a mode change that says nothing, or a shuffle of one song', async () => {
    const t = setup({ items: [song(1)] });
    await expect(t.run('radio_set_rotation_mode', {})).rejects.toThrow(
      'Give mode, loop or both',
    );
    await expect(
      t.run('radio_set_rotation_mode', { mode: 'shuffle' }),
    ).rejects.toThrow('at least two songs');
    expect(t.programs.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(
      (await t.dry('radio_set_rotation_mode', { mode: 'autoplay', loop: true }))
        .summary,
    ).toContain('starts now');
    expect((await t.dry('radio_set_rotation_mode', {})).summary).toContain(
      'nothing new',
    );
    expect(
      (
        await setup({}, true).dry('radio_set_rotation_mode', {
          mode: 'autoplay',
        })
      ).summary,
    ).not.toContain('starts now');
  });

  it('takes a rotation song: saves the cursor and takes it when something plays or the mode is manual', async () => {
    for (const [sequence, playing, taken] of [
      [{}, false, true],
      [{ mode: 'autoplay' }, true, true],
      [{ mode: 'autoplay' }, false, false],
    ] as const) {
      const t = setup(sequence, playing);
      await t.run('radio_take_rotation_song', { item_id: 'row-3' });
      expect(t.saved()[0].songSequence.activeItemId).toBe('row-3');
      expect(t.radio.refuseStartWhileEngineUnavailable).toHaveBeenCalledWith(
        'radio-1',
      );
      expect(t.engine.handleManualSong).toHaveBeenCalledTimes(taken ? 1 : 0);
    }
    const t = setup();
    await expect(
      t.run('radio_take_rotation_song', { item_id: 'block' }),
    ).rejects.toThrow('No rotation song');
    await expect(
      t.run('radio_take_rotation_song', { item_id: 'nope' }),
    ).rejects.toThrow('No rotation song');
    expect(
      (await t.dry('radio_take_rotation_song', { item_id: 'row-1' })).summary,
    ).toContain('rotation song row-1');
    expect(
      (await t.dry('radio_take_rotation_song', { item_id: 'block' })).summary,
    ).toContain('rotation row block');
    t.radio.refuseStartWhileEngineUnavailable.mockRejectedValueOnce(
      new Error('engine off'),
    );
    await expect(
      t.run('radio_take_rotation_song', { item_id: 'row-1' }),
    ).rejects.toThrow();
    expect(t.programs.updateProgramAudioBus).not.toHaveBeenCalled();
  });

  it('moves a row to a position', async () => {
    const t = setup();
    await t.run('radio_move_rotation_song', { item_id: 'row-3', position: 1 });
    expect(t.saved()[0].songSequence.items.map((item) => item.id)).toEqual([
      'row-3',
      'row-1',
      'row-2',
      'block',
    ]);
    await expect(
      t.run('radio_move_rotation_song', { item_id: 'nope', position: 1 }),
    ).rejects.toThrow('No rotation row');
    expect(
      (
        await t.dry('radio_move_rotation_song', {
          item_id: 'row-1',
          position: 99,
        })
      ).summary,
    ).toContain('row 4 of 4');
  });

  // Review of #788: a stored rotation the normalizer accepts can have no items array; the row tools threw a TypeError.
  it('refuses a move cleanly and adds at the end when the stored rotation has no items', async () => {
    const t = setup({ items: undefined, activeItemId: null });
    await expect(
      t.run('radio_move_rotation_song', { item_id: 'row-1', position: 1 }),
    ).rejects.toThrow('No rotation row');
    await t.run('radio_add_rotation_song', { song_id: 5 });
    expect(t.saved()[0].songSequence.items).toHaveLength(1);
  });

  it('adds a library song of the station team at a position or the end', async () => {
    const t = setup();
    await t.run('radio_add_rotation_song', { song_id: 7, position: 2 });
    expect(t.songs.findOne).toHaveBeenCalledWith(7, undefined, 7);
    const items = t.saved()[0].songSequence.items as unknown as Array<
      Record<string, unknown>
    >;
    expect(items[1]).toMatchObject({
      kind: 'preset',
      songId: 7,
      title: 'Added',
      coverUrl: '',
      durationMs: 2000,
      highRotation: false,
    });
    await t.run('radio_add_rotation_song', { song_id: 8 });
    const last = (
      t.saved()[0].songSequence.items as unknown as Array<
        Record<string, unknown>
      >
    ).at(-1)!;
    expect(last.songId).toBe(8);
    expect(last).not.toHaveProperty('durationMs');
    await expect(
      t.run('radio_add_rotation_song', { song_id: 99 }),
    ).rejects.toThrow('disabled or has no audio');
    expect(
      (await t.dry('radio_add_rotation_song', { song_id: 7 })).summary,
    ).toContain('the end');
    expect(
      (await t.dry('radio_add_rotation_song', { song_id: 7, position: 3 }))
        .summary,
    ).toContain('row 3');
  });

  it('names a confirm target from the live stamp and the rotation version for every change', async () => {
    const t = setup();
    for (const spec of t.tools.filter((candidate) => candidate.tier === 'A')) {
      await expect(
        spec.confirmTarget!(
          {
            program_id: 'radio-1',
            sequence_version: 'v1',
            item_id: 'row-1',
            position: 1,
            song_id: 7,
          } as never,
          ctx,
        ),
      ).resolves.toEqual({ id: 'radio-1', name: 'radio-1 · rotation v1' });
      await expect(
        spec.dryRun!(
          {
            program_id: 'radio-1',
            sequence_version: 'v1',
            item_id: 'row-1',
            position: 1,
            song_id: 7,
            mode: 'manual',
          } as never,
          ctx,
        ),
      ).resolves.toMatchObject({ onAir: true });
    }
  });

  it('never gives the rows’ own order when there is another', () => {
    const sequence = normalizeProgramSongSequence({
      items: [song(1), song(2), song(3)],
      activeItemId: 'row-1',
    })!;
    // Every swap with itself leaves the rows' order, so it is turned by one.
    expect(shuffleProgramSongOrder(sequence, (limit) => limit - 1)).toEqual([
      'row-1',
      'row-3',
      'row-2',
    ]);
    expect(
      shuffleProgramSongOrder(
        { ...sequence, activeItemId: null },
        (limit) => limit - 1,
      ),
    ).toEqual(['row-2', 'row-3', 'row-1']);
  });

  // Review of #788: a write made from an old read was checked against a fresh one, so it always passed.
  it('refuses every write made from a rotation version that is no longer the stored one', async () => {
    const t = setup();
    const writes: Array<[string, Record<string, unknown>]> = [
      ['radio_set_rotation_mode', { mode: 'autoplay' }],
      ['radio_take_rotation_song', { item_id: 'row-1' }],
      ['radio_move_rotation_song', { item_id: 'row-1', position: 2 }],
      ['radio_add_rotation_song', { song_id: 5 }],
    ];
    for (const [name, args] of writes) {
      await expect(
        t.run(name, { ...args, sequence_version: 'v0' }),
      ).rejects.toThrow('The rotation changed since that sequence_version');
    }
    expect(t.programs.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(t.engine.handleManualSong).not.toHaveBeenCalled();
    // The version the client read is the one the save sends.
    await t.run('radio_move_rotation_song', { item_id: 'row-1', position: 2 });
    expect(t.saved()[0].sequenceVersion).toBe('v1');
  });

  it('asks for the same permission as the console to take a song on air', () => {
    const t = setup();
    expect(t.tool('radio_take_rotation_song').permission).toBe(
      ALCANTARA_PERMISSIONS.radio.operate,
    );
  });
});

describe('radio_set_rotation_mode summary', () => {
  const summary = async (
    sequence: Record<string, unknown>,
    playing: boolean,
    args: Record<string, unknown>,
  ) => (await setup(sequence, playing).dry('radio_set_rotation_mode', args)).summary;

  it('says what changes, how the rotation stands, and whether it starts now', async () => {
    expect(await summary({ mode: 'manual', loop: true }, false, { mode: 'autoplay', loop: false })).toContain(
      'to mode autoplay and loop off (now manual, loop on). Nothing is on air, so the rotation starts now.',
    );
    const loopOnly = await summary({ mode: 'autoplay', loop: false }, true, { loop: true });
    expect(loopOnly).toContain('to loop on (now autoplay, loop off).');
    expect(loopOnly).not.toContain('starts now');
    const playing = await summary({ mode: 'autoplay', loop: true }, true, { mode: 'shuffle' });
    expect(playing).toContain('to mode shuffle (now autoplay, loop on).');
    expect(playing).not.toContain('starts now');
    expect(await summary({ mode: 'autoplay', loop: true }, false, { mode: 'manual' })).not.toContain('starts now');
    expect(await summary({}, false, {})).toContain('to nothing new');
  });
});
