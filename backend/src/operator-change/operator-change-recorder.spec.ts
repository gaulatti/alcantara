import { ActorContext } from '../auth/actor-context';
import {
  OperatorChangeRecorder,
  summarizeChange,
} from './operator-change-recorder';

// gaulatti/alcantara#236: the record of who changed what is on air. It never fails the change it follows.

const mcp = {
  principalId: 'principal-mcp',
  via: 'mcp' as const,
  client: 'claude-desktop',
};
const console_ = {
  principalId: 'principal-console',
  via: 'console' as const,
  client: null,
};
const summary = {
  changed: ['name'],
  before: { name: 'a' },
  after: { name: 'b' },
};

function build(createError?: unknown) {
  const prisma: any = {
    operatorChangeRecord: {
      create: jest.fn(async () => {
        if (createError !== undefined) throw createError;
        return {};
      }),
    },
  };
  const metrics: any = { recordOperatorChangeRecord: jest.fn() };
  const recorder = new OperatorChangeRecorder(prisma, metrics);
  const warn = jest
    .spyOn((recorder as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { recorder, prisma, metrics, warn };
}

const input = (actor: typeof mcp | typeof console_ | null) => ({
  actor,
  target: 'scene' as const,
  targetId: '7',
  programId: null,
  capability: { mcp: 'scene_update', console: 'scene.update' },
  summary,
});

describe('OperatorChangeRecorder', () => {
  it('reads the acting identity of the command being handled', async () => {
    const { recorder } = build();
    expect(recorder.actor()).toBeNull();
    expect(await ActorContext.run(mcp, async () => recorder.actor())).toEqual(
      mcp,
    );
  });

  it('records nothing for an automatic change that has no actor', async () => {
    const { recorder, prisma, metrics } = build();
    await recorder.record(input(null));
    expect(prisma.operatorChangeRecord.create).not.toHaveBeenCalled();
    expect(metrics.recordOperatorChangeRecord).not.toHaveBeenCalled();
  });

  it('records an MCP change under its capability with the principal and client', async () => {
    const { recorder, prisma, metrics } = build();
    await recorder.record(input(mcp));
    expect(prisma.operatorChangeRecord.create).toHaveBeenCalledWith({
      data: {
        teamId: null,
        programId: null,
        principal: 'principal-mcp',
        via: 'mcp',
        client: 'claude-desktop',
        capability: 'scene_update',
        summary: { target: { kind: 'scene', id: '7' }, ...summary },
      },
    });
    expect(metrics.recordOperatorChangeRecord).toHaveBeenCalledWith(
      'scene',
      'recorded',
    );
  });

  it('records a console change under its route name with no client', async () => {
    const { recorder, prisma } = build();
    await recorder.record({ ...input(console_), programId: 'main' });
    expect(
      prisma.operatorChangeRecord.create.mock.calls[0][0].data,
    ).toMatchObject({
      programId: 'main',
      principal: 'principal-console',
      via: 'console',
      client: null,
      capability: 'scene.update',
    });
  });

  it('warns and counts a failure, and never throws, when the record cannot be stored', async () => {
    const { recorder, metrics, warn } = build(new Error('refused'));
    await expect(recorder.record(input(mcp))).resolves.toBeUndefined();
    expect(metrics.recordOperatorChangeRecord).toHaveBeenCalledWith(
      'scene',
      'failed',
    );
    expect(warn).toHaveBeenCalledWith(
      'Operator change record for scene 7 was not stored; the change stands: refused',
    );
  });

  it('warns generically when the failure is not an Error', async () => {
    const { recorder, warn } = build('boom');
    await recorder.record(input(console_));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
  });
});

describe('summarizeChange', () => {
  const fields = { named: ['text'], valued: ['name', 'when'] };

  it('names the fields given, and values only the allowed ones before and after', () => {
    expect(
      summarizeChange(
        fields,
        { name: 'b', text: 'secret https://x.test?key=1', other: 1 },
        { name: 'a', text: 'old secret' },
        { name: 'b', text: 'secret https://x.test?key=1' },
      ),
    ).toEqual({
      changed: ['text', 'name'],
      before: { name: 'a' },
      after: { name: 'b' },
    });
  });

  it('skips fields not given, tolerates no previous row, and writes dates as ISO text', () => {
    const when = new Date('2026-11-24T10:00:00Z');
    expect(
      summarizeChange(fields, { name: undefined, when: true }, null, { when }),
    ).toEqual({
      changed: ['when'],
      before: { when: null },
      after: { when: '2026-11-24T10:00:00.000Z' },
    });
  });

  it('writes null for a value that is not text, a number, a flag or a date, and tolerates no current row', () => {
    expect(
      summarizeChange(fields, { name: 1 }, { name: { nested: true } }, null),
    ).toEqual({
      changed: ['name'],
      before: { name: null },
      after: { name: null },
    });
  });
});
