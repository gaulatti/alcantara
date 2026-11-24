import { ActorContext } from '../auth/actor-context';
import { LayoutsService } from '../layouts/layouts.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { OperatorChangeRecorder } from './operator-change-recorder';

/**
 * A layout change and its operator change record on PostgreSQL (gaulatti/alcantara#236 slice 2): a layout belongs
 * to no program, so the record carries none; it names the layout and holds the before and after of the name but
 * never the settings, and a refused record write leaves the change in place. Runs when DATABASE_URL names a
 * migrated database.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('layout change and its operator change record', () => {
  let prisma: PrismaService;
  let service: LayoutsService;
  let layoutId: number;
  let metrics: ManagedMetricsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    metrics = new ManagedMetricsService();
    service = new LayoutsService(
      prisma,
      new OperatorChangeRecorder(prisma, metrics),
    );
    const layout = await prisma.layout.create({
      data: {
        name: 'operator-change-fixture',
        componentType: 'ticker',
        settings: '{"url":"https://settings.example.test?key=1"}',
      },
    });
    layoutId = layout.id;
  });

  afterAll(async () => {
    await prisma.operatorChangeRecord.deleteMany({
      where: { summary: { path: ['target', 'id'], equals: String(layoutId) } },
    });
    await prisma.layout.deleteMany({ where: { id: layoutId } });
    await prisma.$disconnect();
  });

  it('records an MCP change with no program, the layout, and the name before and after', async () => {
    await ActorContext.run(
      { principalId: 'principal-mcp', via: 'mcp', client: 'claude-desktop' },
      () =>
        service.update(layoutId, {
          name: 'operator-change-renamed',
          settings: { url: 'https://other.example.test' },
        }),
    );
    const records = await prisma.operatorChangeRecord.findMany({
      where: { summary: { path: ['target', 'id'], equals: String(layoutId) } },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      programId: null,
      principal: 'principal-mcp',
      via: 'mcp',
      client: 'claude-desktop',
      capability: 'layout_update',
      summary: {
        target: { kind: 'layout', id: String(layoutId) },
        changed: ['settings', 'name'],
        before: { name: 'operator-change-fixture' },
        after: { name: 'operator-change-renamed' },
      },
    });
    expect(JSON.stringify(records[0].summary)).not.toContain('example.test');
  });

  it('keeps the change and records nothing when there is no actor', async () => {
    await service.update(layoutId, { name: 'operator-change-automatic' });
    const layout = await prisma.layout.findUniqueOrThrow({
      where: { id: layoutId },
    });
    expect(layout.name).toBe('operator-change-automatic');
    expect(
      await prisma.operatorChangeRecord.count({
        where: {
          summary: { path: ['target', 'id'], equals: String(layoutId) },
        },
      }),
    ).toBe(1);
  });

  it('keeps the change when the record cannot be stored', async () => {
    const failing = new LayoutsService(
      prisma,
      new OperatorChangeRecorder(
        {
          operatorChangeRecord: {
            create: jest.fn().mockRejectedValue(new Error('refused')),
          },
        } as unknown as PrismaService,
        metrics,
      ),
    );
    await ActorContext.run(
      { principalId: 'principal-console', via: 'console', client: null },
      () => failing.update(layoutId, { name: 'operator-change-kept' }),
    );
    const layout = await prisma.layout.findUniqueOrThrow({
      where: { id: layoutId },
    });
    expect(layout.name).toBe('operator-change-kept');
  });
});
