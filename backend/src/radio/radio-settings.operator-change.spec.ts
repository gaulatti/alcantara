import { ActorContext } from '../auth/actor-context';
import { RadioService } from './radio.service';

// gaulatti/alcantara#236: the radio settings write and its operator change record, with a mocked
// Prisma client. The PostgreSQL write-path tests cover the same transaction against a real database.

function build(
  opts: { recordError?: Error; readError?: Error; before?: unknown } = {},
) {
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({ id: 10 }),
    },
    radioSettings: {
      findUnique: jest.fn().mockImplementation(async () => {
        if (opts.readError) throw opts.readError;
        return opts.before === undefined
          ? { enabled: false, bumperMode: 'sequential', segueMode: 'on' }
          : opts.before;
      }),
      upsert: jest.fn().mockResolvedValue({
        id: 1,
        enabled: true,
        bumperMode: 'random',
        segueMode: 'off',
      }),
    },
    operatorChangeRecord: {
      create: jest.fn().mockImplementation(async () => {
        if (opts.recordError) throw opts.recordError;
        return {};
      }),
    },
    $transaction: jest.fn(),
  };
  const palazzo: any = {
    validateBaseUrl: jest.fn((v: string) => v),
  };
  const config: any = { get: jest.fn() };
  const metrics: any = {
    recordListenerConfiguration: jest.fn(),
    recordOperatorChangeRecord: jest.fn(),
  };
  const service = new RadioService(prisma, palazzo, config, metrics, {
    teamId: 0,
  } as never);
  const warn = jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, prisma, metrics, warn };
}

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

describe('radio settings operator change record', () => {
  it('writes settings with no record and no extra read when no actor is in scope', async () => {
    const { service, prisma, metrics } = build();
    await service.updateRadioSettings('p', { enabled: true });
    expect(prisma.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.radioSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.operatorChangeRecord.create).not.toHaveBeenCalled();
    expect(metrics.recordOperatorChangeRecord).not.toHaveBeenCalled();
  });

  it('records an MCP change with its principal, client, capability and before/after, outside any transaction', async () => {
    const { service, prisma, metrics } = build();
    await ActorContext.run(mcp, () =>
      service.updateRadioSettings('p', { enabled: true, bumperMode: 'random' }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.operatorChangeRecord.create).toHaveBeenCalledWith({
      data: {
        teamId: null,
        programId: 'p',
        principal: 'principal-mcp',
        via: 'mcp',
        client: 'claude-desktop',
        capability: 'radio_update_settings',
        summary: {
          changed: ['bumperMode', 'enabled'],
          before: { bumperMode: 'sequential', enabled: false },
          after: { bumperMode: 'random', enabled: true },
        },
      },
    });
    expect(metrics.recordOperatorChangeRecord).toHaveBeenCalledWith('recorded');
  });

  it('records a console change as via=console with capability radio.update-settings', async () => {
    const { service, prisma } = build();
    await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', { segueMode: 'off' }),
    );
    expect(
      prisma.operatorChangeRecord.create.mock.calls[0][0].data,
    ).toMatchObject({
      principal: 'principal-console',
      via: 'console',
      client: null,
      capability: 'radio.update-settings',
      summary: {
        changed: ['segueMode'],
        before: { segueMode: 'on' },
        after: { segueMode: 'off' },
      },
    });
  });

  it('records the change with an empty before when the program had no settings yet', async () => {
    const { service, prisma } = build({ before: null });
    await ActorContext.run(mcp, () =>
      service.updateRadioSettings('p', { enabled: true }),
    );
    expect(
      prisma.operatorChangeRecord.create.mock.calls[0][0].data.summary,
    ).toEqual({
      changed: ['enabled'],
      before: { enabled: null },
      after: { enabled: true },
    });
  });

  it('never copies a URL or other free text into the record, only that the field changed', async () => {
    const { service, prisma } = build();
    await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', {
        palazzoUrl: 'https://palazzo.example.test',
        listenerUrl: 'https://listen.example.test/stream',
        bumperInstantIds: [1],
      } as never),
    );
    const { summary } =
      prisma.operatorChangeRecord.create.mock.calls[0][0].data;
    expect(summary.changed).toEqual(
      expect.arrayContaining(['palazzoUrl', 'listenerUrl', 'bumperInstantIds']),
    );
    expect(summary.before).toEqual({});
    expect(summary.after).toEqual({});
    expect(JSON.stringify(summary)).not.toContain('example.test');
  });

  it('keeps the settings change, warns and counts a failure when the record cannot be stored', async () => {
    const { service, prisma, metrics, warn } = build({
      recordError: new Error('record write refused'),
    });
    const result = await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', {
        enabled: true,
        listenerUrl: 'https://listen.example.test/stream',
      }),
    );
    expect(result).toMatchObject({ id: 1, enabled: true });
    expect(prisma.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(metrics.recordListenerConfiguration).toHaveBeenCalledWith('success');
    expect(metrics.recordOperatorChangeRecord).toHaveBeenCalledWith('failed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the change stands: record write refused'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.test');
  });

  it('warns with a generic message when the record failure is not an Error', async () => {
    const { service, prisma, warn } = build();
    prisma.operatorChangeRecord.create.mockRejectedValueOnce('boom');
    await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', { enabled: true }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
  });

  it('still writes the change and records an empty before when the earlier settings cannot be read', async () => {
    const { service, prisma, warn } = build({
      readError: new Error('read refused'),
    });
    await ActorContext.run(mcp, () =>
      service.updateRadioSettings('p', { enabled: true }),
    );
    expect(prisma.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(
      prisma.operatorChangeRecord.create.mock.calls[0][0].data.summary.before,
    ).toEqual({
      enabled: null,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'could not be read for the operator change record: read refused',
      ),
    );
  });

  it('warns generically when the earlier settings fail to read with a non-Error', async () => {
    const { service, prisma, warn } = build();
    prisma.radioSettings.findUnique.mockRejectedValueOnce('boom');
    await ActorContext.run(mcp, () =>
      service.updateRadioSettings('p', { enabled: true }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
  });

  it('does not record a change that the write itself refused', async () => {
    const { service, prisma, metrics } = build();
    prisma.radioSettings.upsert.mockRejectedValueOnce(
      new Error('database down'),
    );
    await expect(
      ActorContext.run(mcp, () =>
        service.updateRadioSettings('p', { enabled: true }),
      ),
    ).rejects.toThrow('database down');
    expect(prisma.operatorChangeRecord.create).not.toHaveBeenCalled();
    expect(metrics.recordOperatorChangeRecord).not.toHaveBeenCalled();
  });

  it('refuses the change for an unknown program before any record is written', async () => {
    const { service, prisma } = build();
    prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(
      ActorContext.run(mcp, () =>
        service.updateRadioSettings('missing', { enabled: true }),
      ),
    ).rejects.toThrow('Program not found');
    expect(prisma.radioSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.operatorChangeRecord.create).not.toHaveBeenCalled();
  });
});
