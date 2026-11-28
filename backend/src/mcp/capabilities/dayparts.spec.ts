/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import type { McpContext, McpToolSpec } from '../contract';
import { DaypartMcpTools } from './dayparts';

// gaulatti/alcantara#124: clocks and the daypart grid over MCP, through the console's services.
const ctx = {} as McpContext;
const clock = { id: 5, name: 'Fictional morning', rules: {}, revision: 2 };
const rules = { artistSeparation: 0, slots: [{ labelId: 'tag', count: 1 }] };

function setup() {
  const clocks = {
    list: jest.fn().mockResolvedValue([clock]),
    create: jest.fn().mockResolvedValue(clock),
    update: jest.fn().mockResolvedValue(clock),
    delete: jest.fn().mockResolvedValue({ deleted: true }),
  };
  const dayparts = {
    get: jest.fn().mockResolvedValue({ timeZone: null, revision: 0 }),
    check: jest.fn(async (_id: string, input: any) => ({
      timeZone: 'Europe/Rome',
      revision: 0,
      dayparts: input.dayparts,
      programStateId: 3,
    })),
    save: jest.fn().mockResolvedValue({ revision: 1 }),
  };
  const planner = { preview: jest.fn().mockResolvedValue({ hours: [] }) };
  const specs = new DaypartMcpTools(
    clocks as never,
    dayparts as never,
    planner as never,
  ).specs();
  const tool = (name: string) =>
    specs.find((spec) => spec.name === name) as McpToolSpec & {
      dryRun: (args: object, context: McpContext) => Promise<any>;
      run: (args: object, context: McpContext) => Promise<any>;
    };
  return { clocks, dayparts, planner, tool };
}

describe('daypart capabilities', () => {
  it('reads clocks, the grid and the coming hours', async () => {
    const { clocks, dayparts, planner, tool } = setup();
    await tool('program_list_radio_clocks_by_id').run(
      { program_id: 'fm' },
      ctx,
    );
    await tool('program_get_radio_dayparts_by_id').run(
      { program_id: 'fm' },
      ctx,
    );
    const preview = tool('program_preview_radio_dayparts_by_id');
    await preview.run({ program_id: 'fm' }, ctx);
    await preview.run({ program_id: 'fm', hours: 6 }, ctx);
    expect(clocks.list).toHaveBeenCalledWith('fm');
    expect(dayparts.get).toHaveBeenCalledTimes(3);
    expect(planner.preview.mock.calls).toEqual([
      ['fm', 2],
      ['fm', 6],
    ]);
  });

  it('dry-runs a clock change without writing, then writes it', async () => {
    const { clocks, tool } = setup();
    const create = tool('program_create_radio_clock_by_id');
    const update = tool('program_update_radio_clock_by_id');
    const remove = tool('program_delete_radio_clock_by_id');
    const target = { program_id: 'fm', clock_id: 5, revision: 2 };
    const made = { program_id: 'fm', name: 'n', rules };
    for (const [spec, args] of [
      [create, made],
      [update, target],
      [remove, target],
    ] as const)
      expect((await spec.dryRun(args, ctx)).summary).toContain('fm');
    expect(clocks.create).not.toHaveBeenCalled();
    expect(clocks.update).not.toHaveBeenCalled();
    expect(clocks.delete).not.toHaveBeenCalled();
    await create.run(made, ctx);
    await update.run({ ...target, name: 'new' }, ctx);
    await remove.run(target, ctx);
    expect(clocks.create).toHaveBeenCalledWith('fm', { name: 'n', rules });
    expect(clocks.update).toHaveBeenCalledWith('fm', 5, {
      revision: 2,
      name: 'new',
      rules: undefined,
    });
    expect(clocks.delete).toHaveBeenCalledWith('fm', 5, 2);
    await expect(
      update.dryRun({ ...target, clock_id: 9 }, ctx),
    ).rejects.toThrow('clock not found');
  });

  it('checks the grid in a dry run and saves it only when run', async () => {
    const { dayparts, tool } = setup();
    const set = tool('program_set_radio_dayparts_by_id');
    const args = {
      program_id: 'fm',
      revision: 0,
      time_zone: 'Europe/Rome',
      dayparts: [{ dayOfWeek: 1, startHour: 6, endHour: 7, clockId: 5 }],
    };
    expect((await set.dryRun(args, ctx)).summary).toContain('1 daypart(s)');
    expect(
      (await set.dryRun({ ...args, dayparts: [] }, ctx)).summary,
    ).toContain('empty grid');
    expect(dayparts.save).not.toHaveBeenCalled();
    await set.run(args, ctx);
    expect(dayparts.save).toHaveBeenCalledWith('fm', {
      revision: 0,
      timeZone: 'Europe/Rome',
      dayparts: args.dayparts,
    });
  });
});
describe('daypart capabilities decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    const paths = [
      '../../program/radio-clocks.service',
      '../../program/radio-dayparts.service',
      '../../program/radio-daypart-planner.service',
    ];
    jest.isolateModules(() => {
      for (const path of paths) jest.doMock(path, () => ({}));
      const { DaypartMcpTools: Isolated } = require('./dayparts');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
      ]);
    });
    for (const path of paths) jest.dontMock(path);
  });
});
