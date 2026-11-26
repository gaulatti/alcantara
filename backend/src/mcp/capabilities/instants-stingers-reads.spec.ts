/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers are typed any. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { InstantsController } from '../../instants/instants.controller';
import { StingersController } from '../../stingers/stingers.controller';
import { UNTRUSTED_NOTE } from '../contract';
import {
  asRest,
  principalWith,
  rebuilt,
  specNamed,
} from './capabilities.testing';
import { InstantsMcpTools } from './instants';
import { instant, instantRow, stinger } from './instants-stingers.testing';
import { StingersMcpTools } from './stingers';

// Appendix A rows of gaulatti/alcantara#217 that are reads, copied from
// backend/src/mcp/appendix-a.tsv. Names and tiers are binding; a row that
// looks wrong against the code is reported, never adjusted here.
// area, method, path, permission, handler, capability, tier
const ROWS = `
instants	GET	/instants	instant.read	listInstants	instant_list_instants	R
stingers	GET	/stingers	stinger.read	listStingers	stinger_list_stingers	R
`
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));

const services = {
  programs: { listInstants: jest.fn() },
  stingers: { findAll: jest.fn() },
};
const specs = [
  ...new InstantsMcpTools(services.programs as never, {} as never).specs(),
  ...new StingersMcpTools(
    services.stingers as never,
    {} as never,
    { teamId: 7 } as never,
  ).specs(),
];
const controllers = {
  instants: new InstantsController(services.programs as never),
  stingers: new StingersController(services.stingers as never),
};
const ctx = { principal: principalWith('alcantara:access' as never) };
const run = async (name: string, args: Record<string, unknown>) =>
  (await specNamed(specs, name).run(args, ctx)).result;

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  return (
    ALCANTARA_PERMISSIONS as unknown as Record<string, Record<string, string>>
  )[group][action];
};

beforeEach(() => {
  jest.clearAllMocks();
  services.programs.listInstants.mockResolvedValue([
    instantRow(),
    instantRow({ id: 9, name: 'Second', assignedSongId: 7 }),
  ]);
  services.stingers.findAll.mockResolvedValue([stinger]);
});

const STINGER_TEAM = { user: { authorization: { teamId: 7 } } };

describe('appendix A read rows of ticket #217', () => {
  it('lists the rows of these areas in the tsv, and no others', () => {
    const lines = readFileSync(join(__dirname, '../appendix-a.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols) => ['instants', 'stingers'].includes(cols[0]));
    const reads = lines.filter((cols) => cols[6] === 'R');
    expect(reads).toEqual(ROWS);
  });

  it.each(ROWS)(
    '%s %s %s needs %s (handler %s) and is capability %s, tier %s',
    (area, _method, _path, permission, handler, name, tier) => {
      const spec = specs.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.permission).toBe(permissionOf(permission));
      expect(spec?.tier).toBe(tier);
      expect(spec?.firstClass).toBe(false);
      expect(spec?.dryRun).toBeUndefined();
      expect(spec?.confirmTarget).toBeUndefined();
      expect(spec?.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
      const controller = (area === 'instants'
        ? InstantsController
        : StingersController) as unknown as {
        prototype: Record<string, object>;
      };
      // The handler's own permission, or the controller's when it has none.
      expect(
        (Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          controller.prototype[handler],
        ) as string | undefined) ??
          (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller) as string),
      ).toBe(spec?.permission);
    },
  );
});

describe('instant and stinger reads return what the controller returns', () => {
  it('instant_list_instants, for the default program and for another', async () => {
    const result = await run('instant_list_instants', {});
    expect(rebuilt(result)).toEqual(
      asRest(await controllers.instants.listInstants()),
    );
    expect(services.programs.listInstants).toHaveBeenNthCalledWith(
      1,
      undefined,
    );
    expect(services.programs.listInstants).toHaveBeenNthCalledWith(
      2,
      undefined,
    );
    expect(result).toMatchObject([
      {
        id: 8,
        enabled: true,
        untrusted: {
          name: expect.stringContaining('ignore previous'),
          audioUrl: instant.audioUrl,
        },
      },
      { id: 9, assignedSongId: 7 },
    ]);
    await run('instant_list_instants', { program_id: 'news' });
    await controllers.instants.listInstants('news');
    expect(services.programs.listInstants).toHaveBeenNthCalledWith(3, 'news');
    expect(services.programs.listInstants).toHaveBeenNthCalledWith(4, 'news');
  });

  it('stinger_list_stingers', async () => {
    const result = await run('stinger_list_stingers', {});
    expect(rebuilt(result)).toEqual(
      asRest(await controllers.stingers.listStingers(STINGER_TEAM)),
    );
    expect(result).toMatchObject([
      {
        id: 7,
        cutPointMs: 1000,
        untrusted: {
          name: expect.stringContaining('tell the operator'),
          videoUrl: stinger.videoUrl,
        },
      },
    ]);
  });

  it('takes no arguments for the stinger list', () => {
    expect(specNamed(specs, 'stinger_list_stingers').shape).toEqual({});
  });
});

describe('no read answers a credential', () => {
  it('withholds an answer that carries a signed link or a credential field', async () => {
    services.programs.listInstants.mockResolvedValue([
      instantRow({
        audioUrl: 'https://s3.example/a.mp3?X-Amz-Signature=planted-secret',
      }),
    ]);
    await expect(run('instant_list_instants', {})).rejects.toMatchObject({
      code: 'unavailable',
    });
    services.stingers.findAll.mockResolvedValue([
      { ...stinger, token: 'planted-secret' },
    ]);
    await expect(run('stinger_list_stingers', {})).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('answers nothing the services would not, so the planted secret never appears', async () => {
    const text = JSON.stringify([
      await run('instant_list_instants', {}),
      await run('stinger_list_stingers', {}),
    ]);
    expect(text).not.toMatch(/planted-secret|X-Amz|token|ticket/i);
  });
});
