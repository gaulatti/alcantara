import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { InstantsController } from '../../instants/instants.controller';
import { StingersController } from '../../stingers/stingers.controller';
import { UNTRUSTED_NOTE } from '../contract';
import {
  asRest,
  fakeServices,
  principalWith,
  rebuilt,
  specNamed,
  stateOf,
} from './capabilities.testing';
import { InstantsMcpTools } from './instants';
import {
  instant,
  instantRow,
  listed,
  sceneNaming,
  stinger,
} from './instants-stingers.testing';
import { StingersMcpTools } from './stingers';

// Appendix A rows of gaulatti/alcantara#217 that are W, A or D, copied from
// backend/src/mcp/appendix-a.tsv (the program and radio rows that name
// instants and stingers belong to the program and radio areas). Names and tiers
// are binding.
// area, method, path, permission, handler, capability, tier
const ROWS = `
instants	POST	/instants	instant.manage	createInstant	instant_create_instant	W
instants	PUT	/instants/:instantId	instant.manage	updateInstant	instant_update_instant	W
instants	DELETE	/instants/:instantId	instant.manage	deleteInstant	instant_delete_instant	D
instants	POST	/instants/:instantId/play	instant.operate	playInstant	instant_play_instant	A
instants	POST	/instants/stop-all	instant.operate	stopAllInstants	instant_stop_all_instants	A
stingers	POST	/stingers	stinger.manage	createStinger	stinger_create_stinger	W
stingers	PUT	/stingers/:stingerId	stinger.manage	updateStinger	stinger_update_stinger	W
stingers	DELETE	/stingers/:stingerId	stinger.manage	deleteStinger	stinger_delete_stinger	D
`
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  return (
    ALCANTARA_PERMISSIONS as unknown as Record<string, Record<string, string>>
  )[group][action];
};

const ctx = { principal: principalWith('alcantara:access' as never) };

const STINGER_TEAM = { user: { authorization: { teamId: 7 } } };

function build() {
  const programs = {
    ...fakeServices().programs,
    listInstants: jest.fn().mockResolvedValue([instantRow()]),
    createInstant: jest.fn().mockResolvedValue(instantRow()),
    updateInstant: jest.fn().mockResolvedValue(instantRow()),
    deleteInstant: jest.fn().mockResolvedValue({ deletedInstantId: 8 }),
    playInstant: jest.fn().mockResolvedValue({ ok: true }),
    stopAllInstants: jest.fn().mockResolvedValue({ ok: true }),
    listPrograms: jest.fn().mockResolvedValue([listed()]),
  };
  const radio = { getRadioSettings: jest.fn().mockResolvedValue(null) };
  const stingers = {
    findOne: jest.fn().mockResolvedValue(stinger),
    create: jest.fn().mockResolvedValue(stinger),
    update: jest.fn().mockResolvedValue(stinger),
    remove: jest.fn().mockResolvedValue({ deletedStingerId: 7 }),
  };
  const specs = [
    ...new InstantsMcpTools(programs as never, radio as never).specs(),
    ...new StingersMcpTools(
      stingers as never,
      programs as never,
      { teamId: 7 } as never,
    ).specs(),
  ];
  const controllers = {
    instants: new InstantsController(programs as never),
    stingers: new StingersController(stingers as never),
  };
  const run = async (name: string, args: Record<string, unknown>) =>
    (await specNamed(specs, name).run(args, ctx)).result;
  const plan = (name: string, args: Record<string, unknown>) =>
    specNamed(specs, name).dryRun!(args, ctx);
  return { programs, radio, stingers, specs, controllers, run, plan };
}

describe('appendix A write rows of ticket #217', () => {
  const { specs } = build();

  it('lists exactly the W, A and D rows of these areas in the tsv', () => {
    const lines = readFileSync(join(__dirname, '../appendix-a.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(
        (cols) => ['instants', 'stingers'].includes(cols[0]) && cols[6] !== 'R',
      );
    expect(lines).toEqual(ROWS);
  });

  it.each(ROWS)(
    '%s %s %s needs %s (handler %s) and is capability %s, tier %s',
    (area, _method, _path, permission, handler, name, tier) => {
      const spec = specs.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.permission).toBe(permissionOf(permission));
      expect(spec?.tier).toBe(tier);
      expect(spec?.firstClass).toBe(false);
      expect(spec?.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
      expect(spec?.dryRun).toBeDefined();
      expect(spec?.confirmTarget !== undefined).toBe(tier !== 'W');
      const controller = (area === 'instants'
        ? InstantsController
        : StingersController) as unknown as {
        prototype: Record<string, object>;
      };
      expect(
        (Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          controller.prototype[handler],
        ) as string | undefined) ??
          (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller) as string),
      ).toBe(spec?.permission);
    },
  );

  it('registers the read rows and these rows once each, 10 in all (2 R, 4 W, 2 A, 2 D)', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      [
        ...ROWS.map((row) => row[5]),
        'instant_list_instants',
        'stinger_list_stingers',
      ].sort(),
    );
    const tiers = specs.map((spec) => spec.tier);
    for (const [tier, n] of [
      ['R', 2],
      ['W', 4],
      ['A', 2],
      ['D', 2],
    ] as const)
      expect(tiers.filter((t) => t === tier)).toHaveLength(n);
  });
});

describe('instant writes return what the controller returns', () => {
  it('instant_create_instant sends the service what the controller sends', async () => {
    const { programs, controllers, run, plan } = build();
    const body = {
      name: 'Station id',
      audioUrl: 'https://cdn.example/a.mp3',
      volume: 0.5,
      enabled: false,
    };
    const expected = asRest(await controllers.instants.createInstant(body));
    const result = await run('instant_create_instant', {
      name: 'Station id',
      audio_url: 'https://cdn.example/a.mp3',
      volume: 0.5,
      enabled: false,
    });
    expect(programs.createInstant.mock.calls[1]).toEqual(
      programs.createInstant.mock.calls[0],
    );
    expect(rebuilt(result)).toEqual(expected);
    expect(result).toMatchObject({
      untrusted: { name: instant.name, audioUrl: instant.audioUrl },
    });
    expect(
      await plan('instant_create_instant', {
        name: 'x',
        audio_url: 'https://cdn.example/a.mp3',
      }),
    ).toMatchObject({ onAir: false, recoverable: true, affects: [] });
  });

  it('instant_update_instant leaves out what was not given', async () => {
    const { programs, controllers, run } = build();
    await controllers.instants.updateInstant('8', { volume: 0.3 });
    const result = await run('instant_update_instant', {
      instant_id: 8,
      volume: 0.3,
    });
    expect(programs.updateInstant.mock.calls[1]).toEqual(
      programs.updateInstant.mock.calls[0],
    );
    expect(programs.updateInstant).toHaveBeenLastCalledWith(8, { volume: 0.3 });
    expect(rebuilt(result)).toEqual(asRest(instantRow()));
    await run('instant_update_instant', {
      instant_id: 8,
      name: 'N',
      audio_url: 'https://cdn.example/b.mp3',
      enabled: false,
    });
    expect(programs.updateInstant).toHaveBeenLastCalledWith(8, {
      name: 'N',
      audioUrl: 'https://cdn.example/b.mp3',
      enabled: false,
    });
  });

  it('instant_update_instant flags a change that shows on air', async () => {
    const { programs, radio, plan } = build();
    const args = { instant_id: 8, enabled: false };
    expect(await plan('instant_update_instant', args)).toMatchObject({
      onAir: false,
      recoverable: true,
    });
    programs.listPrograms.mockResolvedValue([
      listed({ activeSceneId: 3, scenes: [sceneNaming(8)] }),
    ]);
    const onAir = await plan('instant_update_instant', args);
    expect(onAir.onAir).toBe(true);
    expect(onAir.summary).toMatch(/on air or staged on 1/);
    programs.listPrograms.mockResolvedValue([listed()]);
    radio.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInstantIds: [8],
    });
    const bumper = await plan('instant_update_instant', args);
    expect(bumper.onAir).toBe(true);
    expect(bumper.summary).toMatch(/1 with bumpers on/);
    expect(bumper.affects).toContainEqual({
      kind: 'program',
      id: 'main',
      name: 'main',
    });
  });

  it('report the service refusals as MCP codes', async () => {
    const { programs, run } = build();
    programs.createInstant.mockRejectedValue(
      new BadRequestException('name is required'),
    );
    await expect(
      run('instant_create_instant', { name: 'x', audio_url: 'y' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      run('instant_update_instant', { instant_id: 99 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('instant_play_instant and instant_stop_all_instants', () => {
  it('play reaches the service for the program and answers what the controller answers', async () => {
    const { programs, controllers, run, plan, specs } = build();
    const expected = asRest(
      await controllers.instants.playInstant('8', 'main'),
    );
    const result = await run('instant_play_instant', {
      instant_id: 8,
      program_id: 'main',
    });
    expect(programs.playInstant).toHaveBeenLastCalledWith(8, 'main');
    expect(result).toEqual(expected);
    const plain = await plan('instant_play_instant', {
      instant_id: 8,
      program_id: 'news',
    });
    expect(plain).toMatchObject({ onAir: true, recoverable: true });
    expect(plain.summary).toMatch(/Plays instant 8 once on program news/);
    expect(plain.summary).toMatch(/instant_stop_all_instants cuts it/);
    const target = await specNamed(specs, 'instant_play_instant')
      .confirmTarget!({ instant_id: 8, program_id: 'main' }, ctx);
    expect(target.id).toBe('8');
    expect(target.name).toContain(instant.name);
  });

  it('play changes its confirm name when the instant is disabled, and says the console refuses it', async () => {
    const { programs, plan, specs } = build();
    const args = { instant_id: 8, program_id: 'main' };
    const enabled = await specNamed(specs, 'instant_play_instant')
      .confirmTarget!(args, ctx);
    programs.listInstants.mockResolvedValue([instantRow({ enabled: false })]);
    const disabled = await specNamed(specs, 'instant_play_instant')
      .confirmTarget!(args, ctx);
    expect(disabled.name).not.toBe(enabled.name);
    expect((await plan('instant_play_instant', args)).summary).toMatch(
      /disabled: the console refuses to play it/,
    );
    programs.playInstant.mockRejectedValue(
      new BadRequestException('Instant is disabled'),
    );
    await expect(
      specNamed(specs, 'instant_play_instant').run(args, ctx),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('play reports an unknown instant or program as not_found', async () => {
    const { programs, specs } = build();
    const spec = specNamed(specs, 'instant_play_instant');
    await expect(
      spec.run({ instant_id: 99, program_id: 'main' }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
    programs.getState.mockRejectedValue(new Error('Program not found'));
    await expect(
      spec.run({ instant_id: 8, program_id: 'nowhere' }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(programs.playInstant).not.toHaveBeenCalled();
  });

  it('stop all reaches the service and confirms against the live stamp', async () => {
    const { programs, controllers, run, plan, specs } = build();
    const expected = asRest(await controllers.instants.stopAllInstants('main'));
    expect(
      await run('instant_stop_all_instants', { program_id: 'main' }),
    ).toEqual(expected);
    expect(programs.stopAllInstants).toHaveBeenLastCalledWith('main');
    expect(
      await plan('instant_stop_all_instants', { program_id: 'main' }),
    ).toMatchObject({ onAir: true, recoverable: true });
    const spec = specNamed(specs, 'instant_stop_all_instants');
    const before = await spec.confirmTarget!({ program_id: 'main' }, ctx);
    expect(before.id).toBe('main');
    programs.getState.mockResolvedValue(stateOf({ activeSceneId: 3 }));
    const after = await spec.confirmTarget!({ program_id: 'main' }, ctx);
    expect(after.name).not.toBe(before.name);
  });
});

describe('stinger writes return what the controller returns', () => {
  it('stinger_create_stinger and stinger_update_stinger', async () => {
    const { stingers, controllers, run, plan } = build();
    const expected = asRest(
      await controllers.stingers.createStinger(
        {
          name: 'N',
          videoUrl: 'https://cdn.example/v.webm',
          cutPointMs: 500,
          enabled: false,
        },
        STINGER_TEAM,
      ),
    );
    const created = await run('stinger_create_stinger', {
      name: 'N',
      video_url: 'https://cdn.example/v.webm',
      cut_point_ms: 500,
      enabled: false,
    });
    expect(stingers.create.mock.calls[1]).toEqual(
      stingers.create.mock.calls[0],
    );
    expect(rebuilt(created)).toEqual(expected);
    expect(created).toMatchObject({
      untrusted: { name: stinger.name, videoUrl: stinger.videoUrl },
    });
    await controllers.stingers.updateStinger(
      '7',
      { cutPointMs: 250 },
      STINGER_TEAM,
    );
    const updated = await run('stinger_update_stinger', {
      stinger_id: 7,
      cut_point_ms: 250,
    });
    expect(stingers.update.mock.calls[1]).toEqual(
      stingers.update.mock.calls[0],
    );
    expect(rebuilt(updated)).toEqual(asRest(stinger));
    expect(
      await plan('stinger_create_stinger', {
        name: 'N',
        video_url: 'https://cdn.example/v.webm',
      }),
    ).toMatchObject({ onAir: false, recoverable: true });
  });

  it('stinger_update_stinger flags a stinger that a program on air uses', async () => {
    const { programs, plan } = build();
    const args = { stinger_id: 7, enabled: false };
    programs.listPrograms.mockResolvedValue([
      listed({ stingers: [{ stingerId: 7 }] }),
    ]);
    expect(await plan('stinger_update_stinger', args)).toMatchObject({
      onAir: false,
    });
    programs.listPrograms.mockResolvedValue([
      listed({ fadeToBlack: true, stingers: [{ stingerId: 7 }] }),
    ]);
    const live = await plan('stinger_update_stinger', args);
    expect(live.onAir).toBe(true);
    expect(live.summary).toMatch(/1 of them on air now/);
  });

  it('report the service refusals as MCP codes', async () => {
    const { stingers, run } = build();
    stingers.findOne.mockRejectedValue(
      new NotFoundException('Stinger not found'),
    );
    await expect(
      run('stinger_update_stinger', { stinger_id: 99 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    stingers.create.mockRejectedValue(
      new BadRequestException('name is required'),
    );
    await expect(
      run('stinger_create_stinger', { name: 'x', video_url: 'y' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('no write answers a credential', () => {
  it('withholds a create whose answer carries a signed link', async () => {
    const { programs, stingers, run } = build();
    programs.createInstant.mockResolvedValue(
      instantRow({ audioUrl: 'https://s3.example/a?X-Amz-Signature=planted' }),
    );
    await expect(
      run('instant_create_instant', { name: 'x', audio_url: 'y' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    stingers.update.mockResolvedValue({ ...stinger, secret: 'planted' });
    await expect(
      run('stinger_update_stinger', { stinger_id: 7 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
