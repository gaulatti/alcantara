/* eslint-disable @typescript-eslint/no-unsafe-assignment -- the services are exercised through loosely typed fakes. */
import { NotFoundException } from '@nestjs/common';
import {
  fakeServices,
  layout,
  specNamed,
  stateOf,
  type Fakes,
} from './capabilities.testing';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// Step 0 of every D row (gaulatti/alcantara#216): what the console does when
// the target is on air, queued or referenced, and what this capability does
// instead. The console deletes in every one of these cases; the capability
// refuses with on_air, and its dry run says what would be lost.

const ctx = { principal: {} as never };

function build() {
  const f = fakeServices();
  const specs = [
    ...new ProgramMcpTools(
      f.programs as never,
      f.templates as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new ScenesMcpTools(f.scenes as never, f.programs as never).specs(),
    ...new LayoutsMcpTools(f.layouts as never, f.programs as never).specs(),
    ...new MediaGroupsMcpTools(f.groups as never, f.programs as never).specs(),
  ];
  return { f, spec: (name: string) => specNamed(specs, name) };
}

const live = (f: Fakes, overrides: Record<string, unknown>) => {
  f.programs.getState.mockResolvedValue(stateOf(overrides));
  f.programs.listPrograms.mockResolvedValue([stateOf(overrides)]);
};

async function refused(
  name: string,
  args: Record<string, unknown>,
  prepare: (f: Fakes) => void,
  service: (f: Fakes) => jest.Mock,
  words: RegExp,
) {
  const { f, spec } = build();
  prepare(f);
  const plan = await spec(name).dryRun!(args, ctx);
  expect(plan.onAir).toBe(true);
  expect(plan.summary).toMatch(/^REFUSED \(on_air\): /);
  expect(plan.summary).toMatch(words);
  await expect(spec(name).run(args, ctx)).rejects.toMatchObject({
    code: 'on_air',
    message: expect.stringMatching(words),
  });
  expect(service(f)).not.toHaveBeenCalled();
}

describe('program_delete_program', () => {
  const args = { program_id: 'main' };
  it.each([
    ['a scene on air', { activeSceneId: 3 }, /scene 3 is on air/],
    ['fade to black', { fadeToBlack: true }, /fade to black is on/],
    ['queued songs', { songQueue: [{ id: 'e1' }] }, /1 song\(s\) are queued/],
    [
      'an active flight',
      { activeFlightSequenceId: 4 },
      /flight sequence is active/,
    ],
  ])('is refused with on_air while the program has %s', (_why, state, words) =>
    refused(
      'program_delete_program',
      args,
      (f) => live(f, state),
      (f) => f.programs.deleteProgram,
      words,
    ),
  );

  it('is refused while a song or a scene instant plays', async () => {
    await refused(
      'program_delete_program',
      args,
      (f) =>
        f.programs.getProgramSongPlayback.mockResolvedValue({
          isPlaying: true,
        }),
      (f) => f.programs.deleteProgram,
      /a song is playing/,
    );
    await refused(
      'program_delete_program',
      args,
      (f) =>
        f.programs.getProgramSceneInstantPlayback.mockResolvedValue({
          isPlaying: true,
          sceneId: 3,
        }),
      (f) => f.programs.deleteProgram,
      /a scene instant is playing/,
    );
  });

  it('says what is lost, as unrecoverable, and runs for an idle program', async () => {
    const { f, spec } = build();
    const plan = await spec('program_delete_program').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(
      /1 scene, 1 media group and 1 stinger assignment\(s\), 0 flight sequence\(s\), its song queue/,
    );
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(plan.summary).toMatch(/The console deletes without looking/);
    await expect(
      spec('program_delete_program').run(args, ctx),
    ).resolves.toMatchObject({ result: { deletedProgramId: 'main' } });
    expect(f.programs.deleteProgram).toHaveBeenCalledWith('main');
  });

  it('reports an unknown program as not_found and a foreign key as conflict', async () => {
    const { f, spec } = build();
    f.programs.getState.mockRejectedValue(new Error('Program not found'));
    await expect(
      spec('program_delete_program').run(args, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe.each([
  [
    'program_remove_scene_from_program',
    { program_id: 'main', scene_id: 3 },
    (f: Fakes) => f.programs.removeSceneFromProgram,
    'scene',
  ],
  [
    'program_remove_media_group_from_program',
    { program_id: 'main', media_group_id: 5 },
    (f: Fakes) => f.programs.removeMediaGroupFromProgram,
    'media group',
  ],
  [
    'program_remove_stinger_from_program',
    { program_id: 'main', stinger_id: 7 },
    (f: Fakes) => f.programs.removeStingerFromProgram,
    'stinger',
  ],
])('%s', (name, args, service, what) => {
  it('lists what is lost and runs while the program is off air', async () => {
    const { f, spec } = build();
    const plan = await spec(name).dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(true);
    expect(plan.summary).toMatch(/Lost: /);
    expect(plan.summary).toMatch(/can be added again/);
    expect(plan.summary).toMatch(/The console does this without looking/);
    expect(plan.affects).toEqual([
      { kind: what, id: expect.any(String), name: expect.any(String) },
      { kind: 'program', id: 'main', name: 'main' },
    ]);
    await spec(name).run(args, ctx);
    expect(service(f)).toHaveBeenCalledTimes(1);
  });

  it('is refused with not_found when it is not assigned to the program', async () => {
    const { f, spec } = build();
    f.programs.getState.mockResolvedValue(
      stateOf({ scenes: [], mediaGroups: [], stingers: [] }),
    );
    await expect(spec(name).run(args, ctx)).rejects.toMatchObject({
      code: 'not_found',
      message: `The ${what} is not assigned to this program.`,
    });
    expect(service(f)).not.toHaveBeenCalled();
  });
});

describe('program_remove_scene_from_program', () => {
  const args = { program_id: 'main', scene_id: 3 };
  const remove = (f: Fakes) => f.programs.removeSceneFromProgram;

  it.each([
    ['on air', { activeSceneId: 3 }, /scene 3 is on air on main/],
    ['staged', { stagedSceneId: 3 }, /scene 3 is staged on main/],
  ])('is refused with on_air while the scene is %s', (_why, state, words) =>
    refused(
      'program_remove_scene_from_program',
      args,
      (f) => live(f, state),
      remove,
      words,
    ),
  );

  it('is refused while its background audio plays there', () =>
    refused(
      'program_remove_scene_from_program',
      args,
      (f) =>
        f.programs.getProgramSceneInstantPlayback.mockResolvedValue({
          isPlaying: true,
          sceneId: 3,
        }),
      remove,
      /scene 3 is playing its background audio on main/,
    ));

  it('removes a scene that is not the one on air or staged', async () => {
    const { f, spec } = build();
    live(f, { activeSceneId: 4, stagedSceneId: 9 });
    await spec('program_remove_scene_from_program').run(args, ctx);
    expect(remove(f)).toHaveBeenCalledWith(3, 'main');
  });
});

describe.each([
  [
    'program_remove_media_group_from_program',
    { program_id: 'main', media_group_id: 5 },
    (f: Fakes) => f.programs.removeMediaGroupFromProgram,
    /its live page reads its media groups/,
  ],
  [
    'program_remove_stinger_from_program',
    { program_id: 'main', stinger_id: 7 },
    (f: Fakes) => f.programs.removeStingerFromProgram,
    /its scene changes use its stingers/,
  ],
])('%s while the program is on air', (name, args, service, words) => {
  it.each([
    ['a scene on air', { activeSceneId: 3 }],
    ['fade to black', { fadeToBlack: true }],
  ])('is refused with on_air with %s', (_why, state) =>
    refused(name, args, (f) => live(f, state), service, words),
  );
});

describe('scene_remove', () => {
  const args = { scene_id: 3 };

  it('lists the assignments it would delete and runs for a scene that is off air', async () => {
    const { f, spec } = build();
    const plan = await spec('scene_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.affects).toEqual([
      { kind: 'scene', id: '3', name: 'Evening news' },
      { kind: 'program', id: 'main', name: 'main' },
    ]);
    expect(plan.summary).toMatch(/removes it from 1 program\(s\) \(main\)/);
    expect(plan.summary).toMatch(/It cannot be recovered/);
    expect(plan.summary).toMatch(
      /The console deletes it even when it is on air/,
    );
    await spec('scene_remove').run(args, ctx);
    expect(f.scenes.remove).toHaveBeenCalledWith(3);
  });

  it.each([
    ['on air', { activeSceneId: 3 }, /scene 3 is on air on main/],
    ['staged', { stagedSceneId: 3 }, /scene 3 is staged on main/],
  ])(
    'is refused with on_air while it is %s on a program',
    (_why, state, words) =>
      refused(
        'scene_remove',
        args,
        (f) => live(f, state),
        (f) => f.scenes.remove,
        words,
      ),
  );

  it('is refused for a scene that is both, naming both', () =>
    refused(
      'scene_remove',
      args,
      (f) => live(f, { activeSceneId: 3, stagedSceneId: 3 }),
      (f) => f.scenes.remove,
      /on air on main; scene 3 is staged on main/,
    ));

  it('is not_found for a scene that is not there', async () => {
    const { f, spec } = build();
    f.scenes.findOne.mockResolvedValue(null);
    await expect(spec('scene_remove').run(args, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('layout_remove', () => {
  const args = { layout_id: 2 };
  const used = (f: Fakes, overrides: Record<string, unknown> = {}) => {
    f.layouts.findOne.mockResolvedValue({ ...layout, scenes: [{ id: 3 }] });
    live(f, overrides);
  };

  it('lists what is lost and runs for a layout no scene uses', async () => {
    const { f, spec } = build();
    const plan = await spec('layout_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(/0 scene\(s\) use it now/);
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(plan.affects).toEqual([
      { kind: 'layout', id: '2', name: layout.name },
    ]);
    await spec('layout_remove').run(args, ctx);
    expect(f.layouts.remove).toHaveBeenCalledWith(2);
  });

  it.each([
    ['on air', { activeSceneId: 3 }, /a scene of layout 2 is on air on main/],
    ['staged', { stagedSceneId: 3 }, /a scene of layout 2 is staged on main/],
  ])('is refused with on_air while a scene of it is %s', (_why, state, words) =>
    refused(
      'layout_remove',
      args,
      (f) => used(f, state),
      (f) => f.layouts.remove,
      words,
    ),
  );

  it('is refused with conflict while an off-air scene still uses it, as the database would', async () => {
    const { f, spec } = build();
    used(f);
    await expect(spec('layout_remove').run(args, ctx)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/used by 1 scene/),
    });
    expect(f.layouts.remove).not.toHaveBeenCalled();
  });

  it('is not_found for a layout that is not there', async () => {
    const { f, spec } = build();
    f.layouts.findOne.mockResolvedValue(null);
    await expect(spec('layout_remove').run(args, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('media_group_remove', () => {
  const args = { media_group_id: 5 };

  it('lists the assignments and the media list it would lose, and runs while no assigned program is on air', async () => {
    const { f, spec } = build();
    const plan = await spec('media_group_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.affects).toEqual([
      { kind: 'media_group', id: '5', name: 'Headlines' },
      { kind: 'program', id: 'main', name: 'main' },
    ]);
    expect(plan.summary).toMatch(
      /list of 1 media and its assignment to 1 program\(s\) \(main\)/,
    );
    expect(plan.summary).toMatch(/The media stay/);
    await spec('media_group_remove').run(args, ctx);
    expect(f.groups.remove).toHaveBeenCalledWith(5);
  });

  it.each([
    ['a scene on air', { activeSceneId: 3 }],
    ['fade to black', { fadeToBlack: true }],
  ])('is refused with on_air while an assigned program has %s', (_why, state) =>
    refused(
      'media_group_remove',
      args,
      (f) => live(f, state),
      (f) => f.groups.remove,
      /media group 5 is read by program\(s\) on air: main/,
    ),
  );

  it('ignores a program on air that the group is not assigned to', async () => {
    const { f, spec } = build();
    f.programs.listPrograms.mockResolvedValue([
      stateOf({ activeSceneId: 3, mediaGroups: [] }),
    ]);
    const plan = await spec('media_group_remove').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.affects).toHaveLength(1);
    await spec('media_group_remove').run(args, ctx);
    expect(f.groups.remove).toHaveBeenCalled();
  });

  it("reports the service's not-found as not_found", async () => {
    const { f, spec } = build();
    f.groups.findOne.mockRejectedValue(
      new NotFoundException('Media group not found'),
    );
    await expect(
      spec('media_group_remove').run(args, ctx),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
