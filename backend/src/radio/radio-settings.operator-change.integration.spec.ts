import { ConfigService } from '@nestjs/config';
import { ActorContext } from '../auth/actor-context';
import { PrismaService } from '../prisma.service';
import { RadioService } from './radio.service';

/**
 * The write path of radio settings and their operator change record (gaulatti/alcantara#236), on
 * PostgreSQL: the settings and the record are one transaction; a failed record write rolls the
 * settings change back and the error surfaces; the MCP path records via=mcp with the client, and
 * the console path records via=console. Runs when DATABASE_URL names a migrated database.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const programId = 'operator-change-fixture';

describeWithDatabase('radio settings and their operator change record', () => {
  let prisma: PrismaService;
  let service: RadioService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const metrics = {
      recordListenerConfiguration: jest.fn(),
      recordOperatorChangeRecord: jest.fn(),
    };
    service = new RadioService(
      prisma,
      {} as never,
      new ConfigService({}),
      metrics as never,
      { teamId: 0 } as never,
    );
    await prisma.programState.deleteMany({ where: { programId } });
    await prisma.programState.create({ data: { programId } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION operator_change_refuse() RETURNS trigger AS $$
      BEGIN
        IF NEW."programId" = 'operator-change-refused' THEN
          RAISE EXCEPTION 'record write refused by the fixture';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS operator_change_refuse ON "OperatorChangeRecord";
       CREATE TRIGGER operator_change_refuse BEFORE INSERT ON "OperatorChangeRecord"
       FOR EACH ROW EXECUTE FUNCTION operator_change_refuse();`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS operator_change_refuse ON "OperatorChangeRecord"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS operator_change_refuse()`,
    );
    await prisma.operatorChangeRecord.deleteMany({ where: { programId } });
    await prisma.programState.deleteMany({ where: { programId } });
    await prisma.$disconnect();
  });

  it('records an MCP change with its principal and client, with the before and after of the change', async () => {
    await ActorContext.run(
      { principalId: 'principal-mcp', via: 'mcp', client: 'claude-desktop' },
      () =>
        service.updateRadioSettings(programId, {
          enabled: true,
          bumperMode: 'random',
        }),
    );
    const settings = await prisma.radioSettings.findFirstOrThrow({
      where: { programState: { programId } },
    });
    expect(settings.enabled).toBe(true);
    expect(settings.bumperMode).toBe('random');
    const records = await prisma.operatorChangeRecord.findMany({
      where: { programId },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      principal: 'principal-mcp',
      via: 'mcp',
      client: 'claude-desktop',
      capability: 'radio_update_settings',
    });
    expect(records[0].summary).toEqual({
      changed: ['bumperMode', 'enabled'],
      before: { bumperMode: null, enabled: null },
      after: { bumperMode: 'random', enabled: true },
    });
  });

  it('records a console change as via=console with no client', async () => {
    await ActorContext.run(
      { principalId: 'principal-console', via: 'console', client: null },
      () => service.updateRadioSettings(programId, { segueMode: 'off' }),
    );
    const records = await prisma.operatorChangeRecord.findMany({
      where: { programId, principal: 'principal-console' },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      via: 'console',
      client: null,
      capability: 'radio.update-settings',
    });
  });

  it('keeps the settings change when the record write is refused', async () => {
    const refused = 'operator-change-refused';
    await prisma.programState.deleteMany({ where: { programId: refused } });
    await prisma.programState.create({ data: { programId: refused } });
    await prisma.radioSettings.create({
      data: {
        programState: { connect: { programId: refused } },
        enabled: false,
        palazzoUrl: 'http://palazzo:3100',
      },
    });
    await ActorContext.run(
      { principalId: 'principal-console', via: 'console', client: null },
      () => service.updateRadioSettings(refused, { enabled: true }),
    );
    const settings = await prisma.radioSettings.findFirstOrThrow({
      where: { programState: { programId: refused } },
    });
    expect(settings.enabled).toBe(true);
    expect(
      await prisma.operatorChangeRecord.count({
        where: { programId: refused },
      }),
    ).toBe(0);
    await prisma.programState.deleteMany({ where: { programId: refused } });
  });
});
