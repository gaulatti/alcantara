import { ActorContext } from '../auth/actor-context';
import { RadioService } from './radio.service';

// gaulatti/alcantara#236: the radio settings write and its operator change record, with a mocked
// Prisma client. The PostgreSQL write-path tests cover the same transaction against a real database.

function build(recordError?: Error) {
  const tx: any = {
    radioSettings: {
      upsert: jest.fn().mockResolvedValue({ id: 1, enabled: true }),
    },
    operatorChangeRecord: {
      create: jest.fn().mockImplementation(async () => {
        if (recordError) throw recordError;
        return {};
      }),
    },
  };
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({ id: 10 }),
    },
    radioSettings: tx.radioSettings,
    operatorChangeRecord: tx.operatorChangeRecord,
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const palazzo: any = {
    validateBaseUrl: jest.fn((v: string) => v),
  };
  const config: any = { get: jest.fn() };
  const metrics: any = { recordListenerConfiguration: jest.fn() };
  const service = new RadioService(prisma, palazzo, config, metrics);
  return { service, prisma, tx, metrics };
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
  it('writes settings without a transaction or record when no actor is in scope', async () => {
    const { service, prisma, tx } = build();
    await service.updateRadioSettings('p', { enabled: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(tx.operatorChangeRecord.create).not.toHaveBeenCalled();
  });

  it('records an MCP change with its principal, client and capability in one transaction', async () => {
    const { service, prisma, tx } = build();
    await ActorContext.run(mcp, () =>
      service.updateRadioSettings('p', { enabled: true, bumperMode: 'random' }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(tx.operatorChangeRecord.create).toHaveBeenCalledWith({
      data: {
        teamId: null,
        programId: 'p',
        principal: 'principal-mcp',
        via: 'mcp',
        client: 'claude-desktop',
        capability: 'radio_update_settings',
        summary: {
          changed: ['bumperMode', 'enabled'],
          values: { bumperMode: 'random', enabled: true },
        },
      },
    });
  });

  it('records a console change as via=console with capability radio.update-settings', async () => {
    const { service, tx } = build();
    await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', { segueMode: 'off' }),
    );
    expect(tx.operatorChangeRecord.create.mock.calls[0][0].data).toMatchObject({
      principal: 'principal-console',
      via: 'console',
      client: null,
      capability: 'radio.update-settings',
      summary: { changed: ['segueMode'], values: { segueMode: 'off' } },
    });
  });

  it('never copies a URL or other free text into the summary, only that the field changed', async () => {
    const { service, tx } = build();
    await ActorContext.run(console_, () =>
      service.updateRadioSettings('p', {
        palazzoUrl: 'https://palazzo.example.test',
        listenerUrl: 'https://listen.example.test/stream',
        bumperInstantIds: [1],
      } as never),
    );
    const { summary } = tx.operatorChangeRecord.create.mock.calls[0][0].data;
    expect(summary.changed).toEqual(
      expect.arrayContaining(['palazzoUrl', 'listenerUrl', 'bumperInstantIds']),
    );
    expect(summary.values).toEqual({});
    expect(JSON.stringify(summary)).not.toContain('example.test');
  });

  it('rolls the settings change back and surfaces the error when the record write fails', async () => {
    const failure = new Error('record write refused');
    const { service, prisma, tx, metrics } = build(failure);
    await expect(
      ActorContext.run(console_, () =>
        service.updateRadioSettings('p', {
          enabled: true,
          listenerUrl: 'https://listen.example.test/stream',
        }),
      ),
    ).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.radioSettings.upsert).toHaveBeenCalledTimes(1);
    expect(metrics.recordListenerConfiguration).toHaveBeenCalledWith('failure');
  });

  it('refuses the change for an unknown program before any record is written', async () => {
    const { service, prisma, tx } = build();
    prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(
      ActorContext.run(mcp, () =>
        service.updateRadioSettings('missing', { enabled: true }),
      ),
    ).rejects.toThrow('Program not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.operatorChangeRecord.create).not.toHaveBeenCalled();
  });
});
