/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers are typed any. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { principalWith, specNamed, fakeServices } from './capabilities.testing';
import { InstantsMcpTools } from './instants';
import {
  instant,
  instantRow,
  listed,
  sceneNaming,
  stinger,
} from './instants-stingers.testing';
import { StingersMcpTools } from './stingers';

// Step 0 of both D rows of gaulatti/alcantara#217: what the console does when
// the target is on air, queued or referenced, and what these capabilities do
// instead. The console deletes in every case but a song intro (it checks only
// that the row exists); the capability refuses with on_air, and its dry run
// says what would be lost and that it cannot be recovered.

const ctx = { principal: principalWith('alcantara:access' as never) };

function build() {
  const programs = {
    ...fakeServices().programs,
    listInstants: jest.fn().mockResolvedValue([instantRow()]),
    deleteInstant: jest.fn().mockResolvedValue({ deletedInstantId: 8 }),
    listPrograms: jest.fn().mockResolvedValue([listed()]),
  };
  const radio = { getRadioSettings: jest.fn().mockResolvedValue(null) };
  const stingers = {
    findOne: jest.fn().mockResolvedValue(stinger),
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
  return {
    programs,
    radio,
    stingers,
    spec: (name: string) => specNamed(specs, name),
    listing: (...rows: Array<Record<string, unknown>>) =>
      programs.listPrograms.mockResolvedValue(rows),
  };
}

async function refused(
  name: string,
  args: Record<string, unknown>,
  prepare: (b: ReturnType<typeof build>) => void,
  service: (b: ReturnType<typeof build>) => jest.Mock,
  words: RegExp,
) {
  const b = build();
  prepare(b);
  const plan = await b.spec(name).dryRun!(args, ctx);
  expect(plan.onAir).toBe(true);
  expect(plan.recoverable).toBe(false);
  expect(plan.summary).toMatch(/^REFUSED \(on_air\): /);
  expect(plan.summary).toMatch(words);
  await expect(b.spec(name).run(args, ctx)).rejects.toMatchObject({
    code: 'on_air',
    message: expect.stringMatching(words),
  });
  expect(service(b)).not.toHaveBeenCalled();
}

describe('instant_delete_instant', () => {
  const args = { instant_id: 8 };
  const service = (b: ReturnType<typeof build>) => b.programs.deleteInstant;

  it('is refused while a program is playing it as a scene background', () =>
    refused(
      'instant_delete_instant',
      args,
      (b) =>
        b.programs.getProgramSceneInstantPlayback.mockResolvedValue({
          isPlaying: true,
          sceneId: 3,
          instantId: 8,
        }),
      service,
      /instant 8 is playing as the scene background on main/,
    ));

  it('is not refused for a playback of another instant or one that stopped', async () => {
    const b = build();
    b.programs.getProgramSceneInstantPlayback.mockResolvedValue({
      isPlaying: true,
      sceneId: 3,
      instantId: 9,
    });
    expect(
      (await b.spec('instant_delete_instant').dryRun!(args, ctx)).onAir,
    ).toBe(false);
    b.programs.getProgramSceneInstantPlayback.mockResolvedValue({
      isPlaying: false,
      sceneId: 3,
      instantId: 8,
    });
    expect(
      (await b.spec('instant_delete_instant').dryRun!(args, ctx)).onAir,
    ).toBe(false);
  });

  it('is refused while a scene on air or staged names it as its background audio', async () => {
    await refused(
      'instant_delete_instant',
      args,
      (b) => b.listing(listed({ activeSceneId: 3, scenes: [sceneNaming(8)] })),
      service,
      /a scene on air or staged on main names instant 8/,
    );
    await refused(
      'instant_delete_instant',
      args,
      (b) => b.listing(listed({ stagedSceneId: 3, scenes: [sceneNaming(8)] })),
      service,
      /a scene on air or staged on main names instant 8/,
    );
  });

  it('is refused while a program with bumpers on lists it', () =>
    refused(
      'instant_delete_instant',
      args,
      (b) =>
        b.radio.getRadioSettings.mockResolvedValue({
          bumperEnabled: true,
          bumperInstantIds: [3, 8],
        }),
      service,
      /instant 8 is in the bumper rotation of main/,
    ));

  it('names every reason at once', async () => {
    const b = build();
    b.listing(listed({ activeSceneId: 3, scenes: [sceneNaming(8)] }));
    b.radio.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInstantIds: [8],
    });
    const plan = await b.spec('instant_delete_instant').dryRun!(args, ctx);
    expect(plan.summary).toMatch(/names instant 8.*bumper rotation/);
  });

  it('says what is lost, as unrecoverable, and runs when only an off-air scene and an off bumper list name it', async () => {
    const b = build();
    b.listing(
      listed({ activeSceneId: 4, scenes: [sceneNaming(8), sceneNaming(1, 4)] }),
    );
    b.radio.getRadioSettings.mockResolvedValue({
      bumperEnabled: false,
      bumperInstantIds: [8],
    });
    const plan = await b.spec('instant_delete_instant').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(/media asset/);
    expect(plan.summary).toMatch(/later instants up one place/);
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(plan.summary).toMatch(/It is not a song intro/);
    expect(plan.summary).toMatch(/A scene of 1 program\(s\) names it/);
    expect(plan.summary).toMatch(/bumper rotation of 1 program/);
    expect(plan.summary).toMatch(/The console deletes it whatever is on air/);
    expect(plan.affects).toEqual([
      { kind: 'instant', id: '8', name: instant.name },
      { kind: 'program', id: 'main', name: 'main' },
    ]);
    expect(
      await b.spec('instant_delete_instant').confirmTarget!(args, ctx),
    ).toEqual({ id: '8', name: instant.name });
    await expect(
      b.spec('instant_delete_instant').run(args, ctx),
    ).resolves.toMatchObject({
      result: { deletedInstantId: 8 },
      audit: { target: '8' },
    });
    expect(b.programs.deleteInstant).toHaveBeenCalledWith(8);
  });

  it("reads a scene's settings as a JSON string or an object, and ignores what does not name it", async () => {
    const scene = (metadata: unknown, sceneId = 3) => ({
      sceneId,
      position: 0,
      scene: { id: sceneId, name: 'S', metadata },
    });
    const readers = async (metadata: unknown) => {
      const b = build();
      b.listing(listed({ scenes: [scene(metadata)] }));
      const plan = await b.spec('instant_delete_instant').dryRun!(args, ctx);
      return plan.affects.filter((a) => a.kind === 'program').length;
    };
    expect(await readers('{"sceneInstant":{"instantId":8}}')).toBe(1);
    expect(await readers({ sceneInstant: { instantId: 8 } })).toBe(1);
    expect(await readers('{"sceneInstant":{"instantId":9}}')).toBe(0);
    expect(await readers('not json')).toBe(0);
    expect(await readers('')).toBe(0);
    expect(await readers(null)).toBe(0);
    expect(await readers(undefined)).toBe(0);
    expect(await readers('null')).toBe(0);
    expect(await readers('{}')).toBe(0);
    expect(await readers('{"sceneInstant":null}')).toBe(0);
  });

  it('keeps the console refusal of a song intro, and says so in the dry run', async () => {
    const b = build();
    b.programs.listInstants.mockResolvedValue([
      instantRow({ availableForSongIntro: false }),
    ]);
    const plan = await b.spec('instant_delete_instant').dryRun!(args, ctx);
    expect(plan.summary).toMatch(
      /assigned as a song intro: the console refuses/,
    );
    b.programs.deleteInstant.mockRejectedValue(
      new BadRequestException(
        'Instant is assigned as a song intro; remove the assignment before deleting it',
      ),
    );
    await expect(
      b.spec('instant_delete_instant').run(args, ctx),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports an unknown instant as not_found', async () => {
    const b = build();
    await expect(
      b.spec('instant_delete_instant').run({ instant_id: 99 }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(b.programs.deleteInstant).not.toHaveBeenCalled();
  });
});

describe('stinger_delete_stinger', () => {
  const args = { stinger_id: 7 };
  const service = (b: ReturnType<typeof build>) => b.stingers.remove;
  const uses = { stingers: [{ stingerId: 7 }] };

  it('is refused while a program that uses it has a scene on air', () =>
    refused(
      'stinger_delete_stinger',
      args,
      (b) => b.listing(listed({ activeSceneId: 3, ...uses })),
      service,
      /stinger 7 is used by program\(s\) on air whose scene changes play it: main/,
    ));

  it('is refused while a program that uses it is faded to black', () =>
    refused(
      'stinger_delete_stinger',
      args,
      (b) => b.listing(listed({ fadeToBlack: true, ...uses })),
      service,
      /on air/,
    ));

  it('is not refused for an on-air program that does not use it', async () => {
    const b = build();
    b.listing(
      listed({ activeSceneId: 3, stingers: [{ stingerId: 9 }] }),
      listed({ programId: 'news', ...uses }),
    );
    const plan = await b.spec('stinger_delete_stinger').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.affects).toEqual([
      { kind: 'stinger', id: '7', name: stinger.name },
      { kind: 'program', id: 'news', name: 'news' },
    ]);
  });

  it('says what is lost, as unrecoverable, and runs for a program that is off air', async () => {
    const b = build();
    b.listing(listed(uses));
    const plan = await b.spec('stinger_delete_stinger').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(/takes it off 1 program\(s\) \(main\)/);
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(plan.summary).toMatch(/The console deletes it whatever is on air/);
    expect(
      await b.spec('stinger_delete_stinger').confirmTarget!(args, ctx),
    ).toEqual({ id: '7', name: stinger.name });
    await expect(
      b.spec('stinger_delete_stinger').run(args, ctx),
    ).resolves.toMatchObject({
      result: { deletedStingerId: 7 },
      audit: { target: '7' },
    });
    expect(b.stingers.remove).toHaveBeenCalledWith(7, 7);
  });

  it('reports an unknown stinger as not_found', async () => {
    const b = build();
    b.stingers.findOne.mockRejectedValue(
      new NotFoundException('Stinger not found'),
    );
    await expect(
      b.spec('stinger_delete_stinger').run(args, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
